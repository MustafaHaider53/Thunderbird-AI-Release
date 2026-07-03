/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

const { createEngine } = ChromeUtils.importESModule(
  "chrome://global/content/ml/EngineProcess.sys.mjs"
);

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";

// Default API key. Replace with your own from https://console.groq.com
const DEFAULT_API_KEY = "gsk_YOUR_GROQ_API_KEY_PLACEHOLDER";

function getApiKey() {
  try {
    return Services.prefs.getStringPref(
      "mail.ai_reply.api_key",
      DEFAULT_API_KEY
    );
  } catch {
    return DEFAULT_API_KEY;
  }
}

let gLocalEngine = null;

async function getLocalEngine(progressCallback = null) {
  if (gLocalEngine && gLocalEngine.engineStatus === "ready") {
    return gLocalEngine;
  }
  try {
    Services.prefs.setBoolPref("browser.ml.enable", true);
  } catch (e) {
    console.error("AI Reply: Failed to enable browser.ml.enable", e);
  }
  gLocalEngine = await createEngine({
    taskName: "text-generation",
    modelHub: "huggingface",
    modelId: "HuggingFaceTB/SmolLM2-360M-Instruct-GGUF",
    modelFile: "smollm2-360m-instruct-q8_0.gguf",
    modelRevision: "main",
    kvCacheDtype: "q8_0",
    flashAttn: false,
    useMmap: false,
    useMlock: true,
    backend: "llama.cpp",
    numContext: 2048,
    numBatch: 2048,
    numUbatch: 2048,
  }, (progressData) => {
    if (progressCallback) {
      progressCallback(progressData);
    }
  });
  return gLocalEngine;
}

async function callGroqApi(messages) {
  const apiKey = getApiKey();
  const response = await fetch(GROQ_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages,
      max_tokens: 1024,
      temperature: 0.7,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    if (response.status === 429) {
      throw new Error(
        "Rate limit exceeded. Please wait a moment and try again."
      );
    }
    throw new Error(`Groq API error (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content?.trim() || "";
}

export const AiReplyService = {
  /**
   * @param {string} emailBody - The plain text body of the email to reply to.
   * @param {string} emailSubject - The subject of the email.
   * @param {string} senderName - The name/address of the sender.
   * @param {string|object} [options=""] - Optional user instruction string for tone/style, or an object containing personalization settings.
   * @returns {Promise<string>} The AI-generated reply text.
   */
  async generateReply(emailBody, emailSubject, senderName, options = "") {
    // Support legacy signatures where options is just a string (customPrompt)
    if (typeof options === "string") {
      options = { customPrompt: options };
    }

    let {
      provider = "auto",
      progressCallback = null,
    } = options;

    if (provider === "local") {
      const { systemMessage, userMessage } = this._constructPrompt(
        emailBody,
        emailSubject,
        senderName,
        options,
        true
      );
      const reply = await this.generateReplyWithLocalSLM(systemMessage, userMessage, progressCallback);
      return this._formatLocalReply(reply, senderName, options);
    }

    try {
      const { systemMessage, userMessage } = this._constructPrompt(
        emailBody,
        emailSubject,
        senderName,
        options,
        false
      );
      return await callGroqApi([
        { role: "system", content: systemMessage },
        { role: "user", content: userMessage },
      ]);
    } catch (e) {
      if (provider === "auto") {
        console.warn("AI Reply: Groq generation failed, falling back to local SLM.", e);
        if (progressCallback) {
          progressCallback({
            type: "status",
            statusText: "Groq offline. Falling back to local AI model..."
          });
        }
        const { systemMessage, userMessage } = this._constructPrompt(
          emailBody,
          emailSubject,
          senderName,
          options,
          true
        );
        const reply = await this.generateReplyWithLocalSLM(systemMessage, userMessage, progressCallback);
        return this._formatLocalReply(reply, senderName, options);
      }
      throw e;
    }
  },

  _constructPrompt(emailBody, emailSubject, senderName, options, isLocal = false) {
    let {
      customPrompt = "",
      tone = "auto",
      length = "auto",
      language = "auto",
      salutation = "auto",
      signature = "auto",
      contextMessages = [],
    } = options;

    if (isLocal) {
      // Safely truncate prompt to fit local engine's context and batch constraints
      const cleanBody = emailBody.substring(0, 1000).trim();

      const instructionsMap = {
        english: {
          system: "Write a short, friendly reply to the sender's message.",
          user: 'Write a short reply to this message: "{body}"',
          tone: "in a {tone} tone",
          length: "very short ({length})",
          rules: "Do NOT output any Subject, From, greetings, or signatures. Write ONLY the response body text."
        },
        spanish: {
          system: "Escribe una respuesta corta y amable al mensaje del remitente.",
          user: 'Escribe una respuesta corta a este mensaje: "{body}"',
          tone: "con un tono {tone}",
          length: "muy corta ({length})",
          rules: "NO escribas Asunto, De, saludos ni firmas. Escribe SOLO el texto del cuerpo de la respuesta."
        },
        french: {
          system: "Rédigez une réponse courte et aimable au message de l'expéditeur.",
          user: 'Rédigez une réponse courte à ce message: "{body}"',
          tone: "avec un ton {tone}",
          length: "très courte ({length})",
          rules: "N'écrivez PAS d'Objet, de De, de salutations ou de signatures. Écrivez UNIQUEMENT le corps de la réponse."
        },
        german: {
          system: "Schreiben Sie eine kurze, freundliche Antwort auf die Nachricht des Absenders.",
          user: 'Schreiben Sie eine kurze Antwort auf diese Nachricht: "{body}"',
          tone: "in einem {tone} Ton",
          length: "sehr kurz ({length})",
          rules: "Geben Sie KEINEN Betreff, Von, Grüße oder Signaturen an. Schreiben Sie NUR den Text der Antwort."
        },
        italian: {
          system: "Scrivi una risposta breve e gentile al messaggio del mittente.",
          user: 'Scrivi una risposta breve a questo messaggio: "{body}"',
          tone: "con un tono {tone}",
          length: "molto breve ({length})",
          rules: "NON inserire Oggetto, Da, saluti o firme. Scrivi SOLO il testo del corpo della risposta."
        }
      };

      const langKey = instructionsMap[language.toLowerCase()] ? language.toLowerCase() : "english";
      const config = instructionsMap[langKey];

      // Tone translation
      let toneText = "friendly and professional";
      if (tone !== "auto") {
        const toneMap = {
          english: { casual: "casual", professional: "professional", friendly: "friendly", formal: "formal" },
          spanish: { casual: "informal", professional: "profesional", friendly: "amigable", formal: "formal" },
          french: { casual: "informal", professional: "professionnel", friendly: "amical", formal: "formel" },
          german: { casual: "lässig", professional: "professionell", friendly: "freundlich", formal: "formell" },
          italian: { casual: "informale", professional: "professionale", friendly: "amichevole", formal: "formale" }
        };
        toneText = toneMap[langKey]?.[tone.toLowerCase()] || tone;
      }

      // Length translation
      let lengthText = "1-2 sentences";
      if (length !== "auto") {
        const lengthMap = {
          english: { short: "1-2 sentences", medium: "2-3 sentences", long: "3-4 sentences" },
          spanish: { short: "1-2 frases", medium: "2-3 frases", long: "3-4 frases" },
          french: { short: "1-2 phrases", medium: "2-3 phrases", long: "3-4 phrases" },
          german: { short: "1-2 Sätze", medium: "2-3 Sätze", long: "3-4 Sätze" },
          italian: { short: "1-2 frasi", medium: "2-3 frasi", long: "3-4 frasi" }
        };
        lengthText = lengthMap[langKey]?.[length.toLowerCase()] || length;
      }

      let systemMessage = `You are a helpful email assistant. ${config.system}
- ${config.rules}
- Reply ${config.tone.replace("{tone}", toneText)}.
- Reply ${config.length.replace("{length}", lengthText)}.
- Focus strictly on answering the message directly. Do NOT talk about unrelated topics or projects.`;

      let userMessage = config.user.replace("{body}", cleanBody);
      if (customPrompt) {
        systemMessage += `\n- Additional rule: ${customPrompt}`;
      }

      return { systemMessage, userMessage };
    }

    let systemMessage = `You are a helpful email assistant. Generate a professional email reply.
STRICT FORMATTING RULES - follow exactly:
- Do NOT output any subject line, headers, or markdown formatting.`;

    if (!isLocal) {
      // Large models reason with mock structures perfectly
      systemMessage += `\n- The salutation (greeting) MUST be on its own line, followed by a blank line.
- The body content comes after the blank line.
- Before the closing sign-off, add a blank line.
- The closing sign-off MUST be on its own line.
- The sender's name MUST be on a NEW line immediately after the closing sign-off.
Example structure:
Dear John,

[body paragraph here]

Yours Sincerely,
Mustafa Haider`;
    }

    // Apply Tone
    if (tone !== "auto") {
      systemMessage += `\n- The tone of the email MUST be ${tone}.`;
    } else {
      systemMessage += `\n- Keep the tone professional, natural, and helpful.`;
    }

    // Apply Length
    if (length !== "auto") {
      systemMessage += `\n- The length of the email MUST be ${length}.`;
    } else if (isLocal) {
      systemMessage += `\n- Keep the reply concise (around 2-3 sentences).`;
    }

    // Apply Language
    if (language !== "auto") {
      systemMessage += `\n- The reply MUST be written exclusively in ${language}.`;
    }

    // Apply Salutation
    if (salutation === "none") {
      systemMessage += `\n- Do NOT include any greeting or salutation at the start of the email. Start directly with the body.`;
    } else if (salutation !== "auto") {
      let salutationText = salutation;
      if (salutation === "hi") salutationText = "Hi or Hello";
      if (salutation === "dear") salutationText = "Dear";
      if (salutation === "greetings") salutationText = "Greetings";
      
      systemMessage += `\n- You MUST start the email with the salutation "${salutationText}" followed by the recipient's name and a comma, on its own line. Then a blank line before the body.`;
    } else {
      // Dynamic first name extraction for auto salutation
      let displayName = senderName.split("<")[0].trim();
      let firstName = displayName;
      if (displayName.includes(" ")) {
        firstName = displayName.split(" ")[0];
      }
      firstName = firstName.replace(/["']/g, "").trim();
      if (firstName.includes("@") || !firstName || /^[0-9]+$/.test(firstName)) {
        firstName = "";
      }
      const greetingName = firstName ? ` ${firstName}` : "";
      systemMessage += `\n- Start the email with a greeting: "Hi${greetingName}," on its own line, followed by a blank line.`;
    }

    // Apply Signature / Closing
    if (signature === "none") {
      systemMessage += `\n- Do NOT include any sign-off or closing line. End after the last sentence of the body.`;
    } else if (signature !== "auto") {
      const closingMap = {
        thanks: "Thanks / Regards",
        best: "Best Regards",
        warm: "Warm Regards",
        sincerely: "Yours Sincerely",
        faithfully: "Yours Faithfully",
        truly: "Yours Truly",
        respectfully: "Respectfully",
        cordially: "Cordially",
      };
      const closingText = closingMap[signature] || signature;
      systemMessage += `\n- End the email with a blank line, then the closing phrase "${closingText}," on its own line, then the sender name "Mustafa Haider" on the next line.`;
    } else {
      systemMessage += `\n- End the email with a blank line, then the closing phrase "Best regards," on its own line, then the sender name "Mustafa Haider" on the next line.`;
    }

    if (isLocal) {
      systemMessage += `\n- Write a short, meaningful response based directly on the sender's email. Do NOT hallucinate unrelated topics, projects, or details. Keep it focused only on replying to their message content.`;
    }

    let userMessage = "";
    if (contextMessages.length > 0) {
      userMessage += `--- PREVIOUS CHAT HISTORY CONTEXT (Oldest to Newest) ---\n\n`;
      for (const msg of contextMessages) {
        userMessage += `[Message from ${msg.sender} on ${msg.date}]:\n${msg.body}\n\n`;
      }
      userMessage += `--- END OF CHAT HISTORY ---\n\n`;
      userMessage += `Now, reply to this LATEST EMAIL in the thread:\n`;
    } else {
      userMessage += `Reply to this email:\n`;
    }

    userMessage += `From: ${senderName}\nSubject: ${emailSubject}\n\n${emailBody}`;

    if (customPrompt) {
      userMessage += `\n\nAdditional user instructions to prioritize: ${customPrompt}`;
    }

    return { systemMessage, userMessage };
  },

  _formatLocalReply(reply, senderName, options) {
    let {
      salutation = "auto",
      signature = "auto",
      language = "auto",
    } = options;

    let cleanReply = reply.trim();

    // Clean up any accidentally generated subject line or email headers
    cleanReply = cleanReply.replace(/^(subject|from|to|date|re):.*/gi, "").trim();

    // Clean up any accidentally generated greeting or sign-off from the SLM reply text
    cleanReply = cleanReply.replace(/^(dear|hi|hello|greetings|hey|to)\b.*/gi, "");
    // Remove common sign-offs and signatures
    cleanReply = cleanReply.replace(/\b(best regards|thanks|regards|yours sincerely|sincerely|yours faithfully|yours truly|respectfully|cordially|warm regards|warmly|best|cheers|br),?\s*(mustafa.*)?$/gi, "");

    // Vaporize any residual placeholders or name patterns generated by the SLM
    cleanReply = cleanReply.replace(/\[\s*(your\s+)?name\s*\]/gi, "");
    cleanReply = cleanReply.replace(/\[\s*(your\s+)?email\s*\]/gi, "");
    cleanReply = cleanReply.replace(/your\s+name/gi, "");

    cleanReply = cleanReply.trim();
    if (!cleanReply) {
      cleanReply = reply.trim();
    }

    // 1. Build dynamic recipient name
    let displayName = senderName.split("<")[0].trim();
    let firstName = displayName;
    if (displayName.includes(" ")) {
      firstName = displayName.split(" ")[0];
    }
    firstName = firstName.replace(/["']/g, "").trim();
    if (firstName.includes("@") || !firstName || /^[0-9]+$/.test(firstName)) {
      firstName = "";
    }

    // 2. Build Salutation
    let salutationPrefix = "";
    if (salutation !== "none") {
      let salPrefix = "Hi";
      if (salutation === "dear") salPrefix = "Dear";
      if (salutation === "greetings") salPrefix = "Greetings";

      if (language.toLowerCase() === "spanish") {
        salPrefix = (salutation === "dear") ? "Estimado" : "Hola";
      } else if (language.toLowerCase() === "french") {
        salPrefix = (salutation === "dear") ? "Cher" : "Bonjour";
      } else if (language.toLowerCase() === "german") {
        salPrefix = (salutation === "dear") ? "Sehr geehrter" : "Hallo";
      }

      salutationPrefix = firstName ? `${salPrefix} ${firstName},\n\n` : `${salPrefix},\n\n`;
    }

    // 3. Build Signature
    let signatureSuffix = "";
    if (signature !== "none") {
      const closingMap = {
        thanks: "Thanks / Regards",
        best: "Best Regards",
        warm: "Warm Regards",
        sincerely: "Yours Sincerely",
        faithfully: "Yours Faithfully",
        truly: "Yours Truly",
        respectfully: "Respectfully",
        cordially: "Cordially",
      };
      let closingText = closingMap[signature] || "Best Regards";

      if (language.toLowerCase() === "spanish") {
        closingText = (signature === "thanks") ? "Muchas gracias" : "Atentamente";
      } else if (language.toLowerCase() === "french") {
        closingText = (signature === "thanks") ? "Merci d'avance" : "Cordialement";
      } else if (language.toLowerCase() === "german") {
        closingText = (signature === "thanks") ? "Vielen Dank" : "Mit freundlichen Grüßen";
      }

      signatureSuffix = `\n\n${closingText},\nMustafa Haider`;
    }

    return `${salutationPrefix}${cleanReply}${signatureSuffix}`;
  },

  async generateReplyWithLocalSLM(systemMessage, userMessage, progressCallback = null) {
    const prompt = [
      { role: "system", content: systemMessage },
      { role: "user", content: userMessage },
    ];
    try {
      const engine = await getLocalEngine(progressCallback);
      const res = await engine.run({
        prompt,
        nPredict: 256,
      });
      return res.finalOutput || "";
    } catch (err) {
      console.error("AI Reply: Local SLM generation failed", err);
      if (err.message && (err.message.includes("download") || err.message.includes("fetch") || err.message.includes("network") || err.message.includes("status"))) {
        throw new Error("Local AI model is not downloaded yet. Please connect to the internet once to download the model files.");
      }
      throw err;
    }
  },

  /**
   * @param {string} emailBody - The plain text body of the email to summarize.
   * @returns {Promise<string>} A short summary of the email.
   */
  async generateSummary(emailBody, options = {}) {
    const { provider = "auto", progressCallback = null } = options;

    if (provider === "local") {
      return this.generateSummaryWithLocalSLM(emailBody, progressCallback);
    }

    try {
      return await callGroqApi([
        {
          role: "system",
          content:
            "Summarize the following email in 1-2 sentences. Be concise and factual.",
        },
        { role: "user", content: emailBody },
      ]);
    } catch (e) {
      if (provider === "auto") {
        console.warn("AI Reply: Groq summary failed, falling back to local SLM summaries.", e);
        return this.generateSummaryWithLocalSLM(emailBody, progressCallback);
      }
      throw e;
    }
  },

  async generateSummaryWithLocalSLM(emailBody, progressCallback = null) {
    const cleanBody = emailBody.substring(0, 1000);
    const prompt = [
      {
        role: "system",
        content: "Summarize the following email in 1-2 sentences. Be concise and factual.",
      },
      { role: "user", content: cleanBody }
    ];
    try {
      const engine = await getLocalEngine(progressCallback);
      const res = await engine.run({
        prompt,
        nPredict: 128,
      });
      return res.finalOutput || "";
    } catch (err) {
      console.error("AI Reply: Local SLM summary failed", err);
      if (err.message && (err.message.includes("download") || err.message.includes("fetch"))) {
        throw new Error("Local AI model is not downloaded yet. Please connect to the internet once to download the model files.");
      }
      throw err;
    }
  },
};

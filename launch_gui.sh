#!/bin/bash
# Stop any existing GUI processes
pkill -f Xvfb
pkill -f fluxbox
pkill -f x11vnc
pkill -f websockify
pkill -f thunderbird
sleep 2

# 1. Start virtual display
echo "Starting Xvfb..."
Xvfb :99 -screen 0 1280x900x24 &
sleep 2

# 2. Start Window Manager (so windows can be moved/resized)
echo "Starting Fluxbox..."
DISPLAY=:99 fluxbox &
sleep 1

# 3. Start VNC Server (no password needed since this is a temporary private test)
echo "Starting x11vnc..."
x11vnc -display :99 -nopw -bg -xkb -forever -quiet

# 4. Start noVNC Web Proxy
echo "Starting noVNC (websockify)..."
websockify --web /usr/share/novnc 6080 localhost:5900 &
sleep 2

# 5. Start Thunderbird
echo "Starting Thunderbird..."
export DISPLAY=:99
export MOZ_DISABLE_CONTENT_SANDBOX=1
export MOZ_ALLOW_EXTERNAL_ML_HUB=1
/home/azureuser/firefox/obj-x86_64-pc-linux-gnu/dist/bin/thunderbird --no-remote > /home/azureuser/firefox/tb_error.log 2>&1 &

echo "============================================================"
echo "GUI Environment Started Successfully!"
echo "To view Thunderbird, open your web browser and go to:"
echo "http://<your-azure-vm-ip>:6080/vnc.html"
echo "============================================================"

FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    dbus-x11 \
    xfce4-panel \
    xvfb \
    x11-utils \
    gcc \
    libxtst-dev \
    libgtk-3-0 \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libxss1 \
    libxtst6 \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --shell /bin/bash tray

WORKDIR /workspace
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
RUN chown -R tray:tray /workspace

COPY --chown=tray:tray tests/native-tray/xfce4-panel.xml /home/tray/.config/xfce4/xfconf/xfce-perchannel-xml/xfce4-panel.xml
COPY tests/native-tray/run.sh /usr/local/bin/run-native-tray-test
RUN chmod +x /usr/local/bin/run-native-tray-test

USER tray

ENV HOME=/home/tray \
    DISPLAY=:99 \
    ELECTRON_DISABLE_SANDBOX=1 \
    E2E_NATIVE_TRAY=1 \
    TRAY_ICON_X=16 \
    TRAY_ICON_Y=18 \
    TRAY_MENU_NEW_ALARM_X=100 \
    TRAY_MENU_NEW_ALARM_Y=52 \
    TRAY_MENU_MAIN_X=100 \
    TRAY_MENU_MAIN_Y=76 \
    TRAY_MENU_COUNTDOWN_X=100 \
    TRAY_MENU_COUNTDOWN_Y=100

CMD ["dbus-run-session", "--", "/usr/local/bin/run-native-tray-test"]

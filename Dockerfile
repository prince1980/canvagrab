FROM node:20-slim

# Install system deps for Playwright Firefox + FFmpeg
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files first for better Docker caching
COPY package*.json ./
RUN npm install

# Install Playwright Firefox browser
RUN npx playwright install firefox --with-deps

# Copy app code
COPY . .

# Create required directories
RUN mkdir -p downloads temp

EXPOSE 3000

CMD ["node", "server.js"]

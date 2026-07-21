FROM node:20-bookworm

# Install ffmpeg and canvas native dependencies
RUN apt-get update && \
    apt-get install -y ffmpeg build-essential libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev pkg-config python3 libpng-dev && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package.json bun.lock* package-lock.json* ./

# Install dependencies (ignoring scripts to avoid issues if any)
RUN npm ci --ignore-scripts || npm install --ignore-scripts

# Copy the rest of the application
COPY . .

# Install server-specific dependencies (e.g., canvas, fluent-ffmpeg) and rebuild canvas at root
RUN cd server && npm install && cd .. && npm rebuild canvas

# Build the frontend and backend (Vite + esbuild)
RUN npm run build

# Expose the standard port
EXPOSE 8080

# The server listens on PORT env var if present, otherwise 3000.
# We'll set it to 8080 which is common for Google Cloud Run / Compute Engine
ENV PORT=8080
ENV NODE_ENV=production

# Start the built API server
CMD ["node", "dist/server.cjs"]

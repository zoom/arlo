FROM node:22-slim

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY . .

# Expose port
EXPOSE 3000

# Serve the built bundle and rebuild on change (host/port set in vite.config.js)
CMD ["npm", "start"]

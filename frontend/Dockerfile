FROM node:20-slim

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY . .

# Build static production assets and serve them without the CRA dev server.
RUN npm run build && npm install -g serve@14.2.4

# Expose port
EXPOSE 3000

# Start static production server
CMD ["serve", "-s", "build", "-l", "3000"]

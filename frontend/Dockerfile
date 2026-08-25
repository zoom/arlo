FROM node:20-slim AS build

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY . .

# Build immutable static assets.
RUN npm run build

FROM node:20-slim

WORKDIR /app

RUN npm install -g serve@14.2.4

COPY --from=build --chown=node:node /app/build ./build

# Expose port
EXPOSE 3000

# Start static production server
USER node
CMD ["serve", "-s", "build", "-l", "3000"]

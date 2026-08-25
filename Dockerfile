FROM node:18-alpine

# Create app directory
WORKDIR /app

# Install app dependencies
COPY package*.json ./
RUN npm install --production

# Bundle app source
COPY . .

# Expose port 8080 (standard Fly.io port)
EXPOSE 8080

# Start server
CMD [ "node", "server.js" ]

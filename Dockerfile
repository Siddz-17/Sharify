FROM node:18-alpine

# Create app directory
WORKDIR /app

# Python is used by the YT Music history helper
RUN apk add --no-cache python3 py3-pip
COPY ytm/requirements.txt ytm/requirements.txt
RUN pip install --no-cache-dir --break-system-packages -r ytm/requirements.txt

# Install app dependencies
COPY package*.json ./
RUN npm install --production

# Bundle app source
COPY . .

# Expose port 8080 (standard Fly.io port)
EXPOSE 8080

# Start server
CMD [ "node", "server.js" ]

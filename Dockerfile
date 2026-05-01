# Use a lightweight Node.js image
FROM node:20-slim

# Set up work directory
WORKDIR /app

# Install necessary system dependencies for some npm packages if needed
# (adm-zip and others are mostly JS, so slim should be fine)

# Copy package.json and install dependencies
COPY package*.json ./
RUN npm install --production

# Copy the rest of the application
COPY . .

# Expose port 3000
EXPOSE 3000

# Start the application
CMD ["npm", "start"]

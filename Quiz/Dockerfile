# Use Node.js 18 LTS
FROM node:18

# Set working directory inside the container
WORKDIR /app

# Copy package.json and package-lock.json first to leverage Docker cache
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy all the rest of the project files, including the quiz folder
COPY . .

# Ensure ES Modules works properly
ENV NODE_ENV=production

# Start the bot
CMD ["node", "bot.js"]

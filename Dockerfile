# Keep the Playwright image version equal to the npm package version.
FROM mcr.microsoft.com/playwright:v1.64.1-noble
ENV NODE_ENV=production PORT=8080 HOME=/home/pwuser
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src/ ./src/
COPY public/ ./public/
RUN chown -R pwuser:pwuser /app
USER pwuser
EXPOSE 8080
CMD ["node", "src/server.js"]

# Cheerio-based HTTP crawler - no browser needed
FROM apify/actor-node:20

USER root

COPY package*.json ./
RUN chown myuser:myuser package*.json \
    && npm ci --omit=dev \
    && npm cache clean --force

COPY . ./
RUN chown -R myuser:myuser /home/myuser

USER myuser

CMD ["npm", "start"]
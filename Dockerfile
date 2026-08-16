# Build stage: needs devDependencies (typescript) to compile.
FROM node:20-alpine AS build

WORKDIR /app

COPY package.json package-lock.json* npm-shrinkwrap.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Runtime stage: production dependencies and compiled output only.
FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* npm-shrinkwrap.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# Railway injects PORT; 8081 is Eleanor's own fallback if it's unset.
EXPOSE 8081

CMD ["npm", "start"]

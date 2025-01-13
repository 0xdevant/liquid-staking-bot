FROM node:16-alpine AS base
RUN apk add -U python3 build-base
RUN npm i -g pnpm
WORKDIR /app
COPY ./package.json ./pnpm-lock.yaml ./

FROM base AS builder
RUN pnpm i --frozen-lockfile
COPY ./tsconfig.json ./
COPY ./src/ ./src/
COPY ./etc ./etc
RUN pnpm run build

FROM base
RUN pnpm i --frozen-lockfile --prod
COPY --from=builder /app/dist /app/dist
COPY --from=builder /app/etc /app/
CMD ["pnpm", "run", "start"]

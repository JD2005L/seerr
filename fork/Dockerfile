# Our build on top of the matching upstream release image. Only the compiled
# app (.next, dist) and the API spec change; node_modules come from upstream,
# which is why build.sh checks that our dependencies match UPSTREAM_TAG.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ARG SOURCE_COMMIT
ENV COMMIT_TAG=${SOURCE_COMMIT}
USER root
RUN rm -rf /app/.next /app/dist
COPY --chown=node:node .next /app/.next
COPY --chown=node:node dist /app/dist
COPY --chown=node:node seerr-api.yml /app/seerr-api.yml
RUN printf '{"commitTag":"%s"}\n' "${SOURCE_COMMIT}" > /app/committag.json \
  && chown node:node /app/committag.json
USER node
LABEL org.opencontainers.image.revision=${SOURCE_COMMIT} \
  org.opencontainers.image.source=https://github.com/JD2005L/seerr \
  com.centurylinklabs.watchtower.enable=false

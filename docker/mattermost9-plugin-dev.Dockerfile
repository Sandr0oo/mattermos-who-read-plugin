FROM golang:1.22-bookworm AS go
FROM mattermost/mattermost-team-edition:release-9.11 AS mattermost

FROM node:16.13.1-bullseye

COPY --from=go /usr/local/go /usr/local/go
COPY --from=mattermost /mattermost/bin/mmctl /usr/local/bin/mmctl

ENV PATH="/usr/local/go/bin:${PATH}"
WORKDIR /src

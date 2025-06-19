FROM mcr.microsoft.com/devcontainers/base:ubuntu-24.04

RUN apt-get update

# install nvm
RUN curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
ENV NVM_DIR=~/.nvm
RUN ["/bin/bash", "-c", "source $NVM_DIR/nvm.sh && nvm install --lts"]

# install apt dependencies
RUN apt-get install -y openjdk-17-jdk vim

# install bun
RUN curl -fsSL https://bun.sh/install | bash
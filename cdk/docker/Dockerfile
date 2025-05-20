# Copyright 2024 Amazon.com, Inc. or its affiliates. All Rights Reserved.
# 
# Permission is hereby granted, free of charge, to any person obtaining a copy of
# this software and associated documentation files (the "Software"), to deal in
# the Software without restriction, including without limitation the rights to
# use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
# the Software, and to permit persons to whom the Software is furnished to do so.
# 
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
# FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
# COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
# IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
# CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

# Use Alpine Linux as base image with explicit platform
FROM --platform=linux/amd64 alpine:3.21

# Build arguments
ARG KAFKA_VERSION=3.6.0
ARG SCALA_VERSION=2.13
ARG MSK_IAM_AUTH_VERSION=1.1.7

# Environment variables
ENV KAFKA_VERSION=${KAFKA_VERSION} \
    SCALA_VERSION=${SCALA_VERSION} \
    MSK_IAM_AUTH_VERSION=${MSK_IAM_AUTH_VERSION} \
    JAVA_HOME=/usr/lib/jvm/java-17-openjdk \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/kafka/bin \
    KAFKA_HOME=/opt/kafka \
    JAVA_OPTS="-Xms512m -Xmx1g \
               -XX:+UseG1GC \
               -XX:MaxGCPauseMillis=20 \
               -XX:InitiatingHeapOccupancyPercent=35 \
               -XX:+ExitOnOutOfMemoryError \
               -XX:+HeapDumpOnOutOfMemoryError \
               -XX:HeapDumpPath=/opt/kafka/logs/ \
               -XX:+UseContainerSupport \
               -XX:MaxRAMPercentage=75.0"

# Install system dependencies
RUN apk update && \
    apk add --no-cache \
        busybox \
        coreutils \
        shadow \
        curl \
        tar \
        bash \
        zsh \
        openjdk17 \
        aws-cli \
        gzip \
        procps \
        jq \
        ca-certificates \
        tzdata \
        mawk \
        dos2unix

# Setup Kafka user and directories
RUN groupadd -r kafka && \
    useradd -r -g kafka -d /home/kafka -m kafka && \
    mkdir -p ${KAFKA_HOME}/{logs,config,libs,bin,debug}

# Download and setup Kafka
RUN cd /opt && \
    curl -fSL "https://archive.apache.org/dist/kafka/${KAFKA_VERSION}/kafka_${SCALA_VERSION}-${KAFKA_VERSION}.tgz" -o kafka.tgz && \
    tar xzf kafka.tgz && \
    cp -r kafka_${SCALA_VERSION}-${KAFKA_VERSION}/* ${KAFKA_HOME}/ && \
    rm -rf kafka.tgz kafka_${SCALA_VERSION}-${KAFKA_VERSION}

# Download MSK IAM auth jar and setup SSL
RUN curl -fSL "https://github.com/aws/aws-msk-iam-auth/releases/download/v${MSK_IAM_AUTH_VERSION}/aws-msk-iam-auth-${MSK_IAM_AUTH_VERSION}-all.jar" \
        -o ${KAFKA_HOME}/libs/aws-msk-iam-auth.jar && \
    cp /etc/ssl/certs/java/cacerts ${KAFKA_HOME}/kafka.client.truststore.jks || true

# Copy and setup the script
COPY run-kafka-command.sh /opt/kafka/bin/
RUN set -ex && \
    chmod 755 /opt/kafka/bin/run-kafka-command.sh && \
    chown kafka:kafka /opt/kafka/bin/run-kafka-command.sh && \
    dos2unix /opt/kafka/bin/run-kafka-command.sh && \
    sed -i '1c#!/bin/zsh' /opt/kafka/bin/run-kafka-command.sh && \
    # Create debug script
    echo '#!/bin/sh' > /opt/kafka/bin/debug.sh && \
    chmod 755 /opt/kafka/bin/debug.sh && \
    # Set permissions
    chmod 755 /opt/kafka/bin/*.sh && \
    chown -R kafka:kafka ${KAFKA_HOME}

# Setup client properties
RUN for file in client.properties client-iam.properties client-tls.properties; do \
    touch /opt/$file && \
    chown kafka:kafka /opt/$file; \
    done

# Create startup verification script
RUN echo '#!/bin/sh' > /opt/kafka/bin/startup-check.sh && \
    echo 'echo "Current directory: $(pwd)"' >> /opt/kafka/bin/startup-check.sh && \
    echo 'echo "Contents of /opt/kafka/bin:"' >> /opt/kafka/bin/startup-check.sh && \
    echo 'ls -la /opt/kafka/bin/' >> /opt/kafka/bin/startup-check.sh && \
    echo 'echo "Script contents:"' >> /opt/kafka/bin/startup-check.sh && \
    echo 'cat /opt/kafka/bin/run-kafka-command.sh' >> /opt/kafka/bin/startup-check.sh && \
    echo 'echo "Environment:"' >> /opt/kafka/bin/startup-check.sh && \
    echo 'env' >> /opt/kafka/bin/startup-check.sh && \
    chmod 755 /opt/kafka/bin/startup-check.sh && \
    chown kafka:kafka /opt/kafka/bin/startup-check.sh

# Set working directory and user
WORKDIR ${KAFKA_HOME}
USER kafka

# Create volumes for persistence
VOLUME ["/opt/kafka/logs", "/opt/kafka/debug"]

# Add health check that verifies the basic functionality of the container
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD zsh -c '[ -x "\${KAFKA_HOME}/bin/run-kafka-command.sh" ] && [ -x "\${KAFKA_HOME}/bin/kafka-topics.sh" ] && aws sts get-caller-identity > /dev/null 2>&1 || exit 1'

# Set entrypoint 
ENTRYPOINT ["/opt/kafka/bin/run-kafka-command.sh"]
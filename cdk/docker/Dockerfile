# Copyright 2025 Amazon.com, Inc. or its affiliates. All Rights Reserved.
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

# Use Amazon Corretto as base image 
FROM --platform=linux/amd64 amazoncorretto:21-alpine

# Build arguments
ARG KAFKA_VERSION=3.8.0
ARG SCALA_VERSION=2.13
ARG MSK_IAM_AUTH_VERSION=1.1.7

# Environment variables
ENV KAFKA_VERSION=${KAFKA_VERSION} \
    SCALA_VERSION=${SCALA_VERSION} \
    MSK_IAM_AUTH_VERSION=${MSK_IAM_AUTH_VERSION} \
    JAVA_HOME=/usr/lib/jvm/default-jvm \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/kafka/bin \
    KAFKA_HOME=/opt/kafka \
    JAVA_OPTS="-Xms1g -Xmx4g \
               -XX:+UseContainerSupport \
               -XX:+ExitOnOutOfMemoryError \
               -Dcom.sun.net.ssl.checkRevocation=false \
               -Djava.security.properties=/opt/kafka/config/java.security"

# Install system dependencies
RUN apk update && \
    apk add --no-cache \
        shadow \
        curl \
        tar \
        bash \
        zsh \
        aws-cli \
        jq \
        ca-certificates \
        openssl

# Setup Kafka user and directories
RUN groupadd -r kafka && \
    useradd -r -g kafka -d /home/kafka -m kafka && \
    mkdir -p ${KAFKA_HOME}/{logs,config,libs,bin,debug}

# Download and setup Kafka
RUN cd /opt && \
    curl -fSL "https://downloads.apache.org/kafka/${KAFKA_VERSION}/kafka_${SCALA_VERSION}-${KAFKA_VERSION}.tgz" -o kafka.tgz && \
    tar xzf kafka.tgz && \
    cp -r kafka_${SCALA_VERSION}-${KAFKA_VERSION}/* ${KAFKA_HOME}/ && \
    rm -rf kafka.tgz kafka_${SCALA_VERSION}-${KAFKA_VERSION}

# Download MSK IAM auth jar and setup SSL truststore
RUN curl -fSL "https://github.com/aws/aws-msk-iam-auth/releases/download/v${MSK_IAM_AUTH_VERSION}/aws-msk-iam-auth-${MSK_IAM_AUTH_VERSION}-all.jar" \
        -o ${KAFKA_HOME}/libs/aws-msk-iam-auth.jar && \
    # Create truststore from system cacerts (matching original GitHub version)
    cp ${JAVA_HOME}/lib/security/cacerts /opt/kafka.client.truststore.jks && \
    # Create custom Java security properties to optimize SSL performance
    mkdir -p ${KAFKA_HOME}/config && \
    echo 'jdk.tls.disabledAlgorithms=SSLv3, RC4, DES, MD5withRSA, TLSv1, TLSv1.1' > ${KAFKA_HOME}/config/java.security && \
    echo 'networkaddress.cache.ttl=60' >> ${KAFKA_HOME}/config/java.security && \
    echo 'networkaddress.cache.negative.ttl=10' >> ${KAFKA_HOME}/config/java.security && \
    echo 'jdk.tls.ephemeralDHKeySize=2048' >> ${KAFKA_HOME}/config/java.security && \
    echo 'jdk.tls.rejectClientInitiatedRenegotiation=true' >> ${KAFKA_HOME}/config/java.security

# Copy properties files and script configuration
COPY client-tls.properties /opt/
COPY client-iam.properties /opt/
COPY run-kafka-command.sh /opt/kafka/bin/
RUN set -ex && \
    chmod 755 /opt/kafka/bin/run-kafka-command.sh && \
    chown kafka:kafka /opt/kafka/bin/run-kafka-command.sh && \
    # Set permissions for client properties files and /opt directory
    chown kafka:kafka /opt/client-tls.properties /opt/client-iam.properties && \
    chmod 755 /opt && chown kafka:kafka /opt && \
    # Convert line endings 
    sed -i 's/\r$//' /opt/kafka/bin/run-kafka-command.sh && \
    sed -i '1c#!/bin/zsh' /opt/kafka/bin/run-kafka-command.sh && \
    # Create debug script
    echo '#!/bin/sh' > /opt/kafka/bin/debug.sh && \
    chmod 755 /opt/kafka/bin/debug.sh && \
    # Set permissions
    chmod 755 /opt/kafka/bin/*.sh && \
    chown -R kafka:kafka ${KAFKA_HOME}

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
#!/bin/zsh

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

# Set shell options for better error handling
set -eo pipefail
setopt shwordsplit

# Set Kafka heap options globally
export KAFKA_HEAP_OPTS="-Xms1G -Xmx4g"

# Signal handler function
signal_handler() {
    echo "trap triggered by signal $1"
    ps -weo pid,%cpu,%mem,size,vsize,cmd --sort=-%mem
    trap - EXIT
    exit $2
}

# Memory monitoring function
output_mem_usage() {
    while true; do
        ps -weo pid,%cpu,%mem,rss,cmd --sort=-%mem
        sleep 60
    done
}

# Wait until all jobs are actually running, to ensure all tasks start simultaneously
wait_for_all_tasks() {
    # Print initial waiting message
    echo -n "waiting for all jobs to start: "
    # Keep checking until all jobs are running
    while [[ ${running_jobs:--1} -lt "$args[--num-jobs]" ]]; do
        sleep 1
        echo -n "."
        # Count running jobs using AWS CLI
        running_jobs=$(aws --region $args[--region] \
            --output text \
            batch list-jobs \
            --array-job-id ${AWS_BATCH_JOB_ID%:*} \
            --job-status RUNNING \
            --query 'jobSummaryList | length(@)') || running_jobs=-1
    done
    echo "ready"
}

# Kafka producer performance test command
producer_command() {
    ${KAFKA_HOME}/bin/kafka-producer-perf-test.sh \
        --topic $TOPIC \
        --num-records $(printf '%.0f' $args[--num-records-producer]) \
        --throughput $THROUGHPUT \
        --record-size $(printf '%.0f' $args[--record-size-byte]) \
        --producer-props bootstrap.servers=$PRODUCER_BOOTSTRAP_SERVERS ${(@s/ /)args[--producer-props]} \
        --producer.config /opt/client.properties 2>&1
}

# Kafka consumer performance test command
consumer_command() {
    for config in $args[--consumer-props]; do
        if [[ $config ==  *SSL* ]]; then    # skip encryption config as it's already part of the properties file
            continue
        fi

        echo $config >> /opt/client.properties
    done

    cat /opt/client.properties

    ${KAFKA_HOME}/bin/kafka-consumer-perf-test.sh \
        --topic $TOPIC \
        --messages $(printf '%.0f' $args[--num-records-consumer]) \
        --broker-list $CONSUMER_BOOTSTRAP_SERVERS \
        --consumer.config /opt/client.properties \
        --group $CONSUMER_GROUP \
        --print-metrics \
        --show-detailed-stats \
        --timeout 16000 2>&1
}

# MSK endpoint query function
query_msk_endpoint() {
    if [[ $args[--bootstrap-broker] = "-" ]]
    then
        case $args[--producer-props] in
            *SASL_SSL*)
                PRODUCER_BOOTSTRAP_SERVERS=$(aws --region $args[--region] kafka get-bootstrap-brokers --cluster-arn $args[--msk-cluster-arn]  --query "BootstrapBrokerStringSaslIam" --output text)
                ;;
            *SSL*)
                PRODUCER_BOOTSTRAP_SERVERS=$(aws --region $args[--region] kafka get-bootstrap-brokers --cluster-arn $args[--msk-cluster-arn]  --query "BootstrapBrokerStringTls" --output text)
                ;;
            *)
                PRODUCER_BOOTSTRAP_SERVERS=$(aws --region $args[--region] kafka get-bootstrap-brokers --cluster-arn $args[--msk-cluster-arn]  --query "BootstrapBrokerString" --output text)
                ;;
        esac

        case $args[--consumer-props] in
            *SASL_SSL*)
                CONSUMER_BOOTSTRAP_SERVERS=$(aws --region $args[--region] kafka get-bootstrap-brokers --cluster-arn $args[--msk-cluster-arn]  --query "BootstrapBrokerStringSaslIam" --output text)
                ;;
            *SSL*)
                CONSUMER_BOOTSTRAP_SERVERS=$(aws --region $args[--region] kafka get-bootstrap-brokers --cluster-arn $args[--msk-cluster-arn]  --query "BootstrapBrokerStringTls" --output text)
                ;;
            *)
                CONSUMER_BOOTSTRAP_SERVERS=$(aws --region $args[--region] kafka get-bootstrap-brokers --cluster-arn $args[--msk-cluster-arn]  --query "BootstrapBrokerString" --output text)
                ;;
        esac
    else
        PRODUCER_BOOTSTRAP_SERVERS=$args[--bootstrap-broker]
        CONSUMER_BOOTSTRAP_SERVERS=$args[--bootstrap-broker]
    fi
}

# Signal trap
trap 'signal_handler SIGTERM 15 $LINENO' SIGTERM

# Parse arguments
zparseopts -A args -E -- -region: -msk-cluster-arn: -bootstrap-broker: -num-jobs: -command: -replication-factor: -topic-name: -depletion-topic-name: -record-size-byte: -records-per-sec: -num-partitions: -duration-sec: -producer-props: -num-producers: -num-records-producer: -consumer-props: -size-consumer-group: -num-records-consumer:

date
echo "parsed args: ${(kv)args}"
echo "running command: $args[--command]"

if [[ -f "$ECS_CONTAINER_METADATA_FILE" ]]; then
    CLUSTER=$(cat $ECS_CONTAINER_METADATA_FILE | jq -r '.Cluster')
    INSTANCE_ARN=$(cat $ECS_CONTAINER_METADATA_FILE | jq -r '.ContainerInstanceARN')
    echo -n "running on instance: "
    aws ecs describe-container-instances --region $args[--region] --cluster $CLUSTER --container-instances $INSTANCE_ARN | jq -r '.containerInstances[].ec2InstanceId'
fi

# Create authentication config properties
case $args[--producer-props] in
    *SASL_SSL*)
        cp /opt/client-iam.properties /opt/client.properties
        ;;
    *SSL*)
        cp /opt/client-tls.properties /opt/client.properties
        ;;
    *)
        touch /opt/client.properties
        ;;
esac

# First attempt to get the cluster endpoint
query_msk_endpoint
# Retry loop if endpoint not obtained
while [ -z "$PRODUCER_BOOTSTRAP_SERVERS"  ]; do
    sleep 10
    query_msk_endpoint
done

# Case statement
case $args[--command] in
create-topics)
    echo "Starting topic creation process at $(date '+%Y-%m-%d %H:%M:%S')"
    
    # Create topic for depletion task
    echo "Attempting to create depletion topic"
    if ${KAFKA_HOME}/bin/kafka-topics.sh \
        --bootstrap-server $PRODUCER_BOOTSTRAP_SERVERS \
        --command-config /opt/client.properties \
        --list \
        | grep -q "$args[--depletion-topic-name]"
    then
        echo "Depletion topic '$args[--depletion-topic-name]' already exists"
    else
        while true; do
            if ${KAFKA_HOME}/bin/kafka-topics.sh \
                --bootstrap-server $PRODUCER_BOOTSTRAP_SERVERS \
                --create \
                --topic "$args[--depletion-topic-name]" \
                --partitions $args[--num-partitions] \
                --replication-factor $args[--replication-factor] \
                --config retention.ms=5000 \
                --command-config /opt/client.properties
            then
                echo "Successfully created depletion topic"
                break
            fi
            echo "Waiting 5 seconds before retrying topic creation..."
            sleep 5
        done
    fi

    # Create topic for performance test task
    echo "Attempting to create performance test topic"
    if ${KAFKA_HOME}/bin/kafka-topics.sh \
        --bootstrap-server $PRODUCER_BOOTSTRAP_SERVERS \
        --command-config /opt/client.properties \
        --list \
        | grep -q "$args[--topic-name]"
    then
        echo "Performance test topic '$args[--topic-name]' already exists"
    else
        while true; do
            if ${KAFKA_HOME}/bin/kafka-topics.sh \
                --bootstrap-server $PRODUCER_BOOTSTRAP_SERVERS \
                --create \
                --topic "$args[--topic-name]" \
                --partitions $args[--num-partitions] \
                --replication-factor $args[--replication-factor] \
                --command-config /opt/client.properties \
                --config retention.ms=86400000
            then
                echo "Successfully created performance test topic"
                break
            fi
            echo "Waiting 5 seconds before retrying topic creation..."
            sleep 5
        done
    fi

    # List all topics
    echo "=== Listing all topics at $(date '+%Y-%m-%d %H:%M:%S') ==="

    ALL_TOPICS=$("${KAFKA_HOME}/bin/kafka-topics.sh" \
        --bootstrap-server "${PRODUCER_BOOTSTRAP_SERVERS}" \
        --command-config /opt/client.properties \
        --list)

    echo "System Topics:"
    echo "${ALL_TOPICS}" | grep "^__" | sed 's/^/    /'

    echo "Depletion Topics:"
    echo "${ALL_TOPICS}" | grep "depl$" | sed 's/^/    /'

    echo "Performance Test Topics:"
    echo "${ALL_TOPICS}" | grep -v "^__" | grep -v "depl$" | sed 's/^/    /'

    echo "=== End of topic list ==="
    ;;

delete-topics)
    echo "=== Starting topic deletion at $(date '+%Y-%m-%d %H:%M:%S') ==="
    
    # Get list of all test topics (including both performance test and depletion topics)
    TOPICS_TO_DELETE=$(${KAFKA_HOME}/bin/kafka-topics.sh \
        --bootstrap-server $PRODUCER_BOOTSTRAP_SERVERS \
        --command-config /opt/client.properties \
        --list | grep '^test-[0-9]\+-series-')

    if [ -n "$TOPICS_TO_DELETE" ]; then
        echo "Found topics to delete:"
        echo "Performance Test Topics:"
        echo "$TOPICS_TO_DELETE" | grep -v 'depl$' | sed 's/^/    /'
        echo "Depletion Topics:"
        echo "$TOPICS_TO_DELETE" | grep 'depl$' | sed 's/^/    /'
        
        echo "Deleting topics..."
        for topic in $TOPICS_TO_DELETE; do
            echo "Deleting topic: $topic"
            ${KAFKA_HOME}/bin/kafka-topics.sh \
                --bootstrap-server $PRODUCER_BOOTSTRAP_SERVERS \
                --command-config /opt/client.properties \
                --delete \
                --topic "$topic" || echo "Failed to delete topic: $topic"
        done
    else
        echo "No test topics found to delete"
    fi
    
    # Verify deletion
    REMAINING_TOPICS=$(${KAFKA_HOME}/bin/kafka-topics.sh \
        --bootstrap-server $PRODUCER_BOOTSTRAP_SERVERS \
        --command-config /opt/client.properties \
        --list | grep '^test-[0-9]\+-series-' || true)
    
    if [ -n "$REMAINING_TOPICS" ]; then
        echo "Warning: Some test topics still exist after deletion:"
        echo "$REMAINING_TOPICS" | sed 's/^/    /'
    else
        echo "All test topics successfully deleted"
    fi
    
    # Log deletion completion
    echo "=== Topic deletion completed at $(date '+%Y-%m-%d %H:%M:%S') ==="
    ;;

deplete-credits)
    # Set up depletion parameters
    TOPIC="$args[--depletion-topic-name]"
    THROUGHPUT=-1

    # Synchronize all tasks before starting
    wait_for_all_tasks

    # Run producers (no consumers) to maximize broker load
    if [[ "$AWS_BATCH_JOB_ARRAY_INDEX" -lt $args[--num-producers] ]]; then
        producer_command | mawk -W interactive '
                 /TimeoutException/ { if(++exceptions % 100000 == 0) {print "Filtered", exceptions, "TimeoutExceptions."} } 
                !/TimeoutException/ { print $0 }
            '
    fi
    ;;

run-performance-test)
    # Set up test parameters
    TOPIC="$args[--topic-name]"
    THROUGHPUT=$args[--records-per-sec]

    echo "=== Starting performance test at $(date '+%Y-%m-%d %H:%M:%S') with the following parameters ==="
    echo "    Target topic: $TOPIC"
    echo "    Total number of producers: ${args[--num-producers]}"
    echo "    This is producer job # $AWS_BATCH_JOB_ARRAY_INDEX"
    echo "    Target throughput for this producer job: $THROUGHPUT records/sec"

    # Synchronize all tasks before starting
    wait_for_all_tasks

    # Determine if this task should be a producer or consumer
    if [[ "$AWS_BATCH_JOB_ARRAY_INDEX" -lt $args[--num-producers] ]]; then
        # Producer logic
        echo "Starting producer job # $AWS_BATCH_JOB_ARRAY_INDEX"
        producer_command 2>&1 | tee producer_${AWS_BATCH_JOB_ARRAY_INDEX}.log
    else
        # Consumer logic
        CONSUMER_GROUP="$(((AWS_BATCH_JOB_ARRAY_INDEX - args[--num-producers]) / args[--size-consumer-group]))"
        echo "Starting consumer job $AWS_BATCH_JOB_ARRAY_INDEX (consumer group: $CONSUMER_GROUP)"
        consumer_command 2>&1 | tee consumer_${AWS_BATCH_JOB_ARRAY_INDEX}.log
    fi

    # Log test completion
    echo "=== Performance test completed at $(date '+%Y-%m-%d %H:%M:%S') ==="
    ;;

*)
    echo "unknown command: ${args[--command]}"
    exit 1
    ;;
esac
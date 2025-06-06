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

# Python import statements
import numpy as np
from statistics import mean, stdev

# Producer aggregation functions
producer_aggregation_fns = [
    ('sent_mb_sec', min),
    ('latency_ms_avg', mean),
    ('latency_ms_avg', stdev),
    ('latency_ms_p50', mean),
    ('latency_ms_p50', stdev),
    ('latency_ms_p95', mean),
    ('latency_ms_p95', stdev),
    ('latency_ms_p99', mean),
    ('latency_ms_p99', stdev),
    ('latency_ms_p999', mean),
    ('latency_ms_p999', stdev),
    ('latency_ms_max', max),
    ('latency_ms_max', stdev),
    ('actual_duration_div_requested_duration_sec', max),
    ('start_ts', min),
    ('end_ts', max)
]

# Consumer aggregation functions
consumer_aggregation_fns = [
    ('consumed_mb_sec', sum),
    ('actual_duration_div_requested_duration_sec', max),
    ('actual_duration_sec', max),
    ('requested_duration_sec', max),
]

# Maps AWS MSK broker instance types to numeric identifiers
def broker_type_to_num(broker_type):
    # Extract the instance family from the broker type
    if broker_type.startswith('kafka.'):
        instance_family = broker_type.split('.')[1]
    elif broker_type.startswith('express.'):
        instance_family = 'express.' + broker_type.split('.')[1]
    else:
        instance_family = broker_type
    
    # Map instance families to numeric identifiers
    mapping = {
        't3': 1,        # Burstable instances
        'm5': 10,       # General purpose
        'm7g': 11,      # General purpose (Graviton)
        'express.m7g': 20  # MSK Express (Graviton)
    }
    
    # Default handling
    return mapping.get(instance_family, 'n/a')

# Main function sponsible for aggregating Kafka performance metrics from CloudWatch logs
def aggregate_cw_logs(producer_stats, consumer_stats, partitions, test_details=None):
    producer_aggregated_stats = []
    consumer_aggregated_stats = []
    combined_stats = []
    
    # Early validation step to ensure that the function has the necessary information to proceed
    if not test_details:
        print("No test details provided")
        return [], [], []
    
    # Print progress information
    print(f"\nStarting producer aggregation with {len(producer_stats)} records")
    
    # Extract broker types from test details
    broker_types = [detail.get('cluster_properties', {}).get('broker_type') 
                   for detail in test_details]
    
    # Print broker types
    print(f"Found broker types: {broker_types}")
    
    # Extract unique broker types from producer stats
    broker_types_in_stats = set()
    for stat in producer_stats:
        broker_type = stat['test_params'].get('broker_type')
        if broker_type:
            broker_types_in_stats.add(broker_type)
    
    # Print broker types found in stats
    print(f"Found broker types in stats: {broker_types_in_stats}")
    
    # Create a mapping from topic prefixes to broker types for informational purposes
    topic_prefix_to_broker = {}
    for stat in producer_stats:
        if 'topic' in stat['test_params'] and 'broker_type' in stat['test_params']:
            topic = stat['test_params']['topic']
            prefix = '-'.join(topic.split('-')[:3])
            broker_type = stat['test_params']['broker_type']
            if prefix not in topic_prefix_to_broker:
                topic_prefix_to_broker[prefix] = broker_type
    
    # Print the mapping for informational purposes
    print("Mapping topic prefixes to broker types:", topic_prefix_to_broker)
    
    # Group producer stats by broker_type directly, then by throughput
    execution_stats = {}
    for stat in producer_stats:
        # Use broker_type directly from test_params
        broker_type = stat['test_params'].get('broker_type')
        
        if not broker_type:
            # Skip stats without broker_type
            continue
        
        if broker_type not in execution_stats:
            execution_stats[broker_type] = {}
        
        target_throughput = stat['test_params']['target_throughput']
        if target_throughput not in execution_stats[broker_type]:
            execution_stats[broker_type][target_throughput] = []
        execution_stats[broker_type][target_throughput].append(stat)
    
    # Process each broker type separately
    for broker_type, throughput_stats in execution_stats.items():
        print(f"\nProcessing broker type: {broker_type}")
        print(f"Detected target throughput values: {sorted(throughput_stats.keys())}")
        
        # Get the test details for this broker type
        detail = next((d for d in test_details 
                      if d.get('cluster_properties', {}).get('broker_type') == broker_type), 
                     test_details[0])
        test_params = detail['test_parameters']
        cluster_props = detail['cluster_properties']
        
        # Process each throughput group within this broker type
        for throughput in sorted(throughput_stats.keys()):
            try:
                stats = throughput_stats[throughput]
                
                # Get consumer group information directly from test parameters
                consumer_groups_count = 0
                if 'consumer_groups' in test_params and test_params['consumer_groups']:
                    # Use the num_groups parameter directly from the last consumer group entry
                    consumer_groups_count = test_params['consumer_groups'][-1].get('num_groups', 0)
                
                # Create cleaned parameters
                cleaned_params = {
                    'broker_type': broker_type,  
                    'target_throughput': throughput,
                    'kafka_version': cluster_props.get('kafka_version', 'unknown'),
                    'broker_storage': cluster_props.get('broker_storage', 'unknown'),
                    'in_cluster_encryption': cluster_props.get('in_cluster_encryption', False),
                    'num_partitions': test_params.get('num_partitions', [1])[0],
                    'producer.security.protocol': test_params.get('producer', {}).get('security.protocol', 'PLAINTEXT'),
                    'producer.acks': test_params.get('producer', {}).get('acks', 'all'),
                    'producer.batch.size': test_params.get('producer', {}).get('batch.size', '262114'),
                    'num_producers': test_params.get('num_producers', [1])[0],
                    'num_brokers': cluster_props.get('num_brokers', 'N/A'),  
                    'consumer_groups.num_groups': consumer_groups_count
                }
                
                # Aggregate metrics
                agg_test_results = {}
                metrics = ['records', 'records_sec', 'sent_mb_sec', 
                          'latency_ms_avg', 'latency_ms_max', 
                          'latency_ms_p50', 'latency_ms_p95', 
                          'latency_ms_p99', 'latency_ms_p999']
               
                # Calculate aggregate statistics for each performance metric
                for metric in metrics:
                    values = [float(stat['test_results'][metric]) for stat in stats]
                    if values:
                        agg_test_results[metric] = sum(values) / len(values)
                        if metric.startswith('latency_ms_'):
                            agg_test_results[f"{metric}_stdev"] = stdev(values) if len(values) > 1 else 0
                
                # Build the final aggregated results
                producer_aggregated_stats.append({
                    'test_params': cleaned_params,
                    'test_results': agg_test_results
                })
                
                # Print a success message for each throughput group that was successfully aggregated
                print(f"Successfully aggregated group for throughput {throughput}")

            # Error handling    
            except Exception as e:
                print(f"Error aggregating producer stats for throughput {throughput}: {str(e)}")
                continue
    
    # Print a summary message indicating how many aggregated records were created
    print(f"Finished producer aggregation with {len(producer_aggregated_stats)} records")
    
    # Return the final results of the aggregation process:
    return producer_aggregated_stats, consumer_aggregated_stats, combined_stats
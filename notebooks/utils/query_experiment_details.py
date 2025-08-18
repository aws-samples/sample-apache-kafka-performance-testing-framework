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
import re
import time
import dateutil.parser
from datetime import datetime
from collections import defaultdict

# Define the maximum number of concurrent CloudWatch Logs queries that can be executed simultaneously
cwlogs_query_limit = 4

# Query CloudWatch logs from test details using simple CloudWatch Logs Insights queries
def obtain_raw_logs(test_details, cloudwatch_logs):
    try:
        # Initialize results collection
        all_results = []
        
        # Iterate through each test detail in the test_details list.
        for test_detail in test_details:
            # Ensure that only test details with valid log group names are processed
            if 'log_group_name' not in test_detail:
                continue

            # Print information about the log group being queried and the time range for the query    
            print(f"\nQuerying log group: {test_detail['log_group_name']}")
            print(f"Time range: {test_detail['start_date']} to {test_detail['stop_date']}")
            
            # Initialize logs collection
            all_logs = []
            
            # Run separate queries for different types of logs
            
            # Query for topic information
            print("Querying for topic information...")
            topic_query = cloudwatch_logs.start_query(
                logGroupName=test_detail['log_group_name'],
                startTime=int(test_detail['start_date'].timestamp()),
                endTime=int(test_detail['stop_date'].timestamp()),
                queryString="""
                fields @timestamp, @message, @logStream
                | filter @message like "--topic-name"
                | sort @timestamp asc
                | limit 10000
                """
            )
            
            # Wait for the query to complete
            topic_query_id = topic_query['queryId']
            topic_status = 'Running'
            while topic_status == 'Running':
                time.sleep(1)
                topic_result = cloudwatch_logs.get_query_results(queryId=topic_query_id)
                topic_status = topic_result['status']
            
            # Print information about the number of topic entries found in the CloudWatch Logs query results
            print(f"Found {len(topic_result.get('results', []))} topic entries.")
            all_logs.extend(topic_result.get('results', []))
            
            # Query for producer results
            print("Querying for producer results...")
            producer_query = cloudwatch_logs.start_query(
                logGroupName=test_detail['log_group_name'],
                startTime=int(test_detail['start_date'].timestamp()),
                endTime=int(test_detail['stop_date'].timestamp()),
                queryString="""
                fields @timestamp, @message, @logStream
                | filter @message like "records sent" and @message like "ms 99.9th"
                | sort @timestamp asc
                | limit 10000
                """
            )
            
            # Wait for the query to complete
            producer_query_id = producer_query['queryId']
            producer_status = 'Running'
            while producer_status == 'Running':
                time.sleep(1)
                producer_result = cloudwatch_logs.get_query_results(queryId=producer_query_id)
                producer_status = producer_result['status']
            
            # Print information about the producer results found in the CloudWatch Logs query results
            print(f"Found {len(producer_result.get('results', []))} producer results.")
            all_logs.extend(producer_result.get('results', []))
            
            # Query for timeout errors with time range splitting
            print("Querying for timeout errors with time range splitting...")
            timeout_results = []

            # Calculate the total time range
            start_time = int(test_detail['start_date'].timestamp())
            end_time = int(test_detail['stop_date'].timestamp())
            total_duration = end_time - start_time

            # Split the time range into smaller chunks
            num_chunks = 15  
            chunk_duration = total_duration / num_chunks

            # Run a query for each time chunk
            for i in range(num_chunks):
                chunk_start = start_time + int(i * chunk_duration)
                chunk_end = start_time + int((i + 1) * chunk_duration)
                if i == num_chunks - 1:
                    chunk_end = end_time  
                
                # Print progress information on which time chunk is being queried
                print(f"Querying timeout errors for time chunk {i+1}/{num_chunks}...")
                timeout_chunk_query = cloudwatch_logs.start_query(
                    logGroupName=test_detail['log_group_name'],
                    startTime=chunk_start,
                    endTime=chunk_end,
                    queryString="""
                    fields @timestamp, @message, @logStream
                    | filter @message like "TimeoutException"
                    | sort @timestamp asc
                    | limit 10000
                    """
                )
                
                # Wait for the query to complete
                timeout_chunk_query_id = timeout_chunk_query['queryId']
                timeout_chunk_status = 'Running'
                while timeout_chunk_status == 'Running':
                    time.sleep(1)
                    timeout_chunk_result = cloudwatch_logs.get_query_results(queryId=timeout_chunk_query_id)
                    timeout_chunk_status = timeout_chunk_result['status']
                
                # Extract and aggregate chunk results
                chunk_results = timeout_chunk_result.get('results', [])
                print(f"Found {len(chunk_results)} timeout errors in chunk {i+1}.")
                timeout_results.extend(chunk_results)

            # Print summary of timeout errors
            print(f"Found a total of {len(timeout_results)} timeout errors across all time chunks.")
            all_logs.extend(timeout_results)
            
            # Query for consumer results
            print("Querying for consumer results...")
            consumer_query = cloudwatch_logs.start_query(
                logGroupName=test_detail['log_group_name'],
                startTime=int(test_detail['start_date'].timestamp()),
                endTime=int(test_detail['stop_date'].timestamp()),
                queryString="""
                fields @timestamp, @message, @logStream
                | filter @message like "Processed a total of"
                | sort @timestamp asc
                | limit 10000
                """
            )
            
            # Wait for the query to complete
            consumer_query_id = consumer_query['queryId']
            consumer_status = 'Running'
            while consumer_status == 'Running':
                time.sleep(1)
                consumer_result = cloudwatch_logs.get_query_results(queryId=consumer_query_id)
                consumer_status = consumer_result['status']
            
            # Print information about the consumer results found in the CloudWatch Logs query results
            print(f"Found {len(consumer_result.get('results', []))} consumer results.")
            all_logs.extend(consumer_result.get('results', []))
            
            # Add the results to the test detail
            test_detail['cwlogs_query_result'] = {'results': all_logs}
            all_results.append(test_detail)
        
        # Successfully returns the processed data
        return all_results
    
    # Error handling
    except Exception as e:
        print(f"Error in obtain_raw_logs: {str(e)}")
        raise

# Extract logStream from CloudWatch log entry
def key_by_logstream_fn(x):
    return x['@logStream']

# Compile regex patterns to process and analyze Kafka performance test results stored in CloudWatch logs
# Pattern to match producer performance test results
# Captures: records sent, throughput (records/sec), throughput (MB/sec),
# average latency, max latency, and percentile latencies (50th, 95th, 99th, 99.9th)
producer_result_p = re.compile(r'''
    (\d+)\s+records\ssent,\s+                # Total records sent
    (\d+\.?\d*)\s+records/sec\s+             # Throughput (records/sec)
    \((\d+\.?\d*)\s+MB/sec\),\s+             # Throughput (MB/sec)
    (\d+\.?\d*)\s+ms\s+avg\s+latency,\s+     # Average latency
    (\d+\.?\d*)\s+ms\s+max\s+latency,\s+     # Maximum latency
    (\d+)\s+ms\s+50th,\s+                    # 50th percentile latency
    (\d+)\s+ms\s+95th,\s+                    # 95th percentile latency
    (\d+)\s+ms\s+99th,\s+                    # 99th percentile latency
    (\d+)\s+ms\s+99\.9th                     # 99.9th percentile latency
''', re.VERBOSE)

# Pattern to match consumer performance test results
# Captures: total records processed and processing rate
consumer_result_p = re.compile(r'''
    Processed\s+a\s+total\s+of\s+
    (\d+)\s+records,\s+                      # Total records processed
    (\d+\.?\d*)\s+records/sec                # Processing rate
''', re.VERBOSE)

# Pattern to match consumer timeout exceptions
# Captures: number of expired records, topic/partition info, and timeout duration
consumer_timeout_p = re.compile(r'''
    org\.apache\.kafka\.common\.errors\.TimeoutException:\s+
    Expiring\s+
    (\d+)\s+record\(s\)\s+for\s+             # Number of expired records
    (.*?):                                   # Topic/partition information
    (\d+)\s+ms\s+                            # Timeout duration
    has\s+passed\s+since\s+batch\s+creation
''', re.VERBOSE)

# Query CloudWatch logs and process results for Kafka performance tests
def query_cw_logs(test_details, cloudwatch_logs):

    try:
        # Enrich test_details with CloudWatch log query results
        test_details = obtain_raw_logs(test_details, cloudwatch_logs)
        
        # Initialize both producer and consumer stats lists
        producer_stats = []
        consumer_stats = []  
        processed_messages = set()

        # Progress indicator
        print("\nAnalyzing log messages...")
        
        # Process the enriched test details
        for raw_test_result in test_details:

            # Data validation and control flow
            if 'cwlogs_query_result' not in raw_test_result:
                continue
            
            # Transform the CloudWatch Logs query results into a more usable format
            statistics_result = []
            for result in raw_test_result['cwlogs_query_result'].get('results', []):
                entry = {}
                for item in result:
                    entry[item['field']] = item['value']
                statistics_result.append(entry)
            
            # Count different types of log entries
            topic_count = sum(1 for entry in statistics_result if '--topic-name' in entry.get('@message', ''))
            producer_count = sum(1 for entry in statistics_result if 'records sent' in entry.get('@message', '') and 'ms 99.9th' in entry.get('@message', ''))
            consumer_count = sum(1 for entry in statistics_result if 'Processed a total of' in entry.get('@message', ''))
            timeout_count = sum(1 for entry in statistics_result if 'TimeoutException' in entry.get('@message', ''))
            
            # Print comprehensive summary of all the different types of log entries found in the CloudWatch Logs query results
            print(f"Found {topic_count} topic entries, {producer_count} producer results, {consumer_count} consumer results, and {timeout_count} timeout errors")

            # Extract test prefix from Kafka topic name and store it in the test results
            message = statistics_result[0].get('@message', '')
            topic_match = re.search(r'--topic-name (test-\d+-series-\d+-t(\d+)-\S+)', message)
            topic_name = topic_match.group(1)
            prefix = '-'.join(topic_name.split('-')[:3])
            print(f"The performance test prefix is: {prefix}")
            raw_test_result["test_prefix"] = prefix

            # Create a map of log streams to topics
            log_stream_to_topic = {}
            for entry in statistics_result:
                message = entry.get('@message', '')
                log_stream = entry.get('@logStream', '')
                
                # Check for topic configuration and create topic mapping
                if '--topic-name' in message:
                    topic_match = re.search(r'--topic-name (test-\d+-series-\d+-t(\d+)-\S+)', message)
                    if topic_match:
                        topic_name = topic_match.group(1)
                        throughput = int(topic_match.group(2))
                        log_stream_to_topic[log_stream] = {
                            'topic': topic_name,
                            'target_throughput': throughput,
                            'timestamp': entry.get('@timestamp', '')
                        }
            
            # Print count of Log Streams with topic information
            print(f"Found {len(log_stream_to_topic)} log streams with topic information")
            
            # Process entries using the log stream to topic mapping
            current_test_info = None
            for entry in statistics_result:
                message = entry.get('@message', '')
                timestamp = entry.get('@timestamp', '')
                log_stream = entry.get('@logStream', '')
                
                # Look for test configuration
                if '--topic-name' in message:
                    topic_match = re.search(r'--topic-name (test-\d+-series-\d+-t(\d+)-\S+)', message)
                    if topic_match:
                        current_test_info = {
                            'topic': topic_match.group(1),
                            'target_throughput': int(topic_match.group(2)),
                            'timestamp': timestamp
                        }
                
                # Look for producer results
                elif 'records sent' in message and 'ms 99.9th' in message:
                    if message in processed_messages:
                        continue

                    # Track processed messages and extract producer metrics
                    processed_messages.add(message)
                    final_match = producer_result_p.search(message)
                    
                    # Get the topic info from the log stream
                    topic_info = log_stream_to_topic.get(log_stream, current_test_info)
                    
                    # Validate data availability and create structured result
                    if final_match and topic_info:
                        try:
                            result = {
                                'test_params': {
                                    'topic': topic_info['topic'],
                                    'target_throughput': topic_info['target_throughput'],
                                    # Add all test parameters from raw_test_result
                                    **raw_test_result.get('test_parameters', {}),
                                    # Add all cluster properties from raw_test_result
                                    **raw_test_result.get('cluster_properties', {})
                                },
                                'timestamp': dateutil.parser.parse(timestamp),
                                'test_results': {
                                    'records': int(final_match.group(1)),
                                    'records_sec': float(final_match.group(2)),
                                    'sent_mb_sec': float(final_match.group(3)),
                                    'latency_ms_avg': float(final_match.group(4)),
                                    'latency_ms_max': float(final_match.group(5)),
                                    'latency_ms_p50': int(final_match.group(6)),
                                    'latency_ms_p95': int(final_match.group(7)),
                                    'latency_ms_p99': int(final_match.group(8)),
                                    'latency_ms_p999': int(final_match.group(9))
                                }
                            }
                            producer_stats.append(result)

                        # Error handling        
                        except Exception as e:
                            print(f"Error processing producer result: {str(e)}")
                
                # Look for consumer results
                elif 'Processed a total of' in message:
                    if message in processed_messages:
                        continue

                    # Track processed messages and extract consumer metrics    
                    processed_messages.add(message)
                    consumer_match = consumer_result_p.search(message)
                    
                    # Get the topic info from the log stream
                    topic_info = log_stream_to_topic.get(log_stream, current_test_info)
                    
                    # Validate data availability and create structured result
                    if consumer_match and topic_info:
                        try:
                            consumer_result = {
                                'test_params': {
                                    'topic': topic_info['topic'],
                                    'target_throughput': topic_info['target_throughput'],
                                    # Add all test parameters from raw_test_result
                                    **raw_test_result.get('test_parameters', {}),
                                    # Add all cluster properties from raw_test_result
                                    **raw_test_result.get('cluster_properties', {})
                                },
                                'timestamp': dateutil.parser.parse(timestamp),
                                'test_results': {
                                    'consumed_records': int(consumer_match.group(1)),
                                    'consumed_records_sec': float(consumer_match.group(2))
                                }
                            }
                            consumer_stats.append(consumer_result)

                        # Error handling       
                        except Exception as e:
                            print(f"Error processing consumer result: {str(e)}")
                
                # Look for timeout errors
                elif 'TimeoutException' in message:
                    if message in processed_messages:
                        continue

                    # Track processed messages and extract timeout error metrics       
                    processed_messages.add(message)
                    timeout_match = consumer_timeout_p.search(message)
                    
                    # Extract topic information from the timeout message if no topic info is available
                    topic_info = log_stream_to_topic.get(log_stream, current_test_info)
                    if not topic_info:
                        topic_match = re.search(r'for (test-\d+-series-\d+-t(\d+)-\S+)-', message)
                        if topic_match:
                            topic_info = {
                                'topic': topic_match.group(1),
                                'target_throughput': int(topic_match.group(2)),
                                'timestamp': timestamp
                            }
                    # Validate data availability and create structured result
                    if timeout_match and topic_info:
                        try:
                            timeout_info = {
                                'test_params': {
                                    'topic': topic_info['topic'],
                                    'target_throughput': topic_info['target_throughput'],
                                    # Add all test parameters from raw_test_result
                                    **raw_test_result.get('test_parameters', {}),
                                    # Add all cluster properties from raw_test_result
                                    **raw_test_result.get('cluster_properties', {})
                                },
                                'timestamp': dateutil.parser.parse(timestamp),
                                'timeout_info': {
                                    'expired_records': int(timeout_match.group(1)),
                                    'topic_partition': timeout_match.group(2),
                                    'timeout_ms': int(timeout_match.group(3))
                                }
                            }
                            # Add timeout info to consumer stats
                            consumer_stats.append(timeout_info)

                        # Error handling     
                        except Exception as e:
                            print(f"Error processing timeout: {str(e)}")
            
        # Create a set of topics with timeout errors
        topics_with_timeout_errors = set()
        for raw_test_result in test_details:
            if 'cwlogs_query_result' not in raw_test_result:
                continue
                
            statistics_result = []
            for result in raw_test_result.get('cwlogs_query_result', {}).get('results', []):
                entry = {}
                for item in result:
                    entry[item['field']] = item['value']
                
                message = entry.get('@message', '')
                log_stream = entry.get('@logStream', '')
                
                if 'TimeoutException' in message:
                    # Try to extract topic from the message
                    topic_match = re.search(r'for (test-\d+-series-\d+-t(\d+)-\S+)-', message)
                    if topic_match:
                        topics_with_timeout_errors.add(topic_match.group(1))
        
        # Print a summary of the topics with timeout errors
        print(f"Found {len(topics_with_timeout_errors)} topics with timeout errors: {', '.join(sorted(topics_with_timeout_errors))}")
        
        # Filter out producer results for topics with timeout errors
        filtered_producer_stats = [stat for stat in producer_stats if stat['test_params']['topic'] not in topics_with_timeout_errors]
        
        # Print information about how many producer results were filtered out due to timeout errors
        print(f"Filtered out {len(producer_stats) - len(filtered_producer_stats)} producer results for topics with timeout errors")
        producer_stats = filtered_producer_stats
        
        # Group results by topic for summary
        results_by_topic = defaultdict(list)
        for stat in producer_stats:
            topic = stat['test_params'].get('topic', '')
            if topic:
                results_by_topic[topic].append(stat)

        # Print summary of results
        print("\nResults summary:")
        for topic, results in sorted(results_by_topic.items()):
            print(f"Topic {topic}: {len(results)} results")
        
        # Print final results
        print(f"Retrieved {len(producer_stats)} producer stats and {len(consumer_stats)} consumer stats")
        
        # Return producer stats, consumer stats, and enriched test details with prefixes
        return (producer_stats, consumer_stats, test_details)
    
    # Error handling
    except Exception as e:
        print(f"Error in query_cw_logs: {str(e)}")
        raise
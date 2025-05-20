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

# Essential imports
import re
import os
import math
import random
import sys
import json
import logging

# Configure logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Initialize random number generator with system time
random.seed()

# Main function handling test parameter updates for performance testing
def increment_index_and_update_parameters(event, context):
    try:
        logger.info(f"Processing event: {json.dumps(event, indent=2)}")
        test_specification = event["test_specification"]
        # Continuing test logic
        if "current_test" in event:
            previous_test_index = event["current_test"]["index"]
            current_parameters = event["current_test"]["parameters"]
            test_id = current_parameters["test_id"]
            
            try:
                updated_test_index = None
                new_series_id = None
                # Skip condition handling
                if ("skip_remaining_throughput" in test_specification and 
                    "producer_result" in event):
                    skip_condition = test_specification["skip_remaining_throughput"]
                    
                    if evaluate_skip_condition(skip_condition, event):
                        logger.info("Skip condition met, moving to next consumer group")
                        # Use the dedicated function to handle skipping to next consumer group
                        updated_test_index, new_series_id = skip_remaining_throughput(
                            previous_test_index,
                            event
                        )
                    else:
                        logger.info("Skip condition not met, continuing with next throughput")
                        updated_test_index, new_series_id = increment_test_index(
                            previous_test_index,
                            event,
                            0  # Start with throughput parameter
                        )
                # Normal progression
                else:
                    logger.info("Normal parameter progression")
                    updated_test_index, new_series_id = increment_test_index(
                        previous_test_index,
                        event,
                        0
                    )

                logger.info(f"Updated test index: {json.dumps(updated_test_index, indent=2)}")
                logger.info(f"New series ID: {new_series_id}")

                # If we have a valid next test index, update parameters
                if updated_test_index is not None:
                    result = update_parameters(
                        test_specification,
                        updated_test_index,
                        test_id,
                        new_series_id
                    )
                    logger.info(f"Returning result: {json.dumps(result, indent=2)}")
                    return result
                else:
                    logger.info("No more parameters to test")
                    return {"test_specification": test_specification}
                
            except OverflowError:
                logger.info("All test combinations exhausted")
                return {"test_specification": test_specification}
        else:
            # First test initialization
            logger.info("Starting first test")
            updated_test_index = {key: 0 for key in test_specification["parameters"].keys()}
            test_id = random.randint(0,100000)
            series_id = random.randint(0,100000)
            result = update_parameters(
                test_specification,
                updated_test_index,
                test_id,
                series_id
            )
            logger.info(f"Returning initial result: {json.dumps(result, indent=2)}")
            return result
    
    # Error handling        
    except Exception as e:
        logger.error(f"Error in increment_index_and_update_parameters: {str(e)}")
        raise

# Function evaluating the stop condition in the test specification
def evaluate_skip_condition(condition, event):
    try:
        if isinstance(condition, dict):
            if "greater-than" in condition:
                args = condition["greater-than"]
                return evaluate_skip_condition(args[0], event) > evaluate_skip_condition(args[1], event)
            elif "less-than" in condition:
                args = condition["less-than"]
                return evaluate_skip_condition(args[0], event) < evaluate_skip_condition(args[1], event)
            else:
                raise ValueError(f"Unknown condition operator in: {condition}")
        # Stop condition evaluation
        elif isinstance(condition, str):
            if condition == "sent_div_requested_mb_per_sec":
                # Producer result processing
                producer_result = event.get("producer_result", {})
                if isinstance(producer_result, list):
                    # Handle multiple producer results
                    total_mb_per_sec = 0
                    for result in producer_result:
                        test_summary = result.get("test_summary", {})
                        if isinstance(test_summary, dict):
                            mb_value = test_summary.get("mb_per_sec", 0)
                            # Handle when mb_per_sec might be a string
                            total_mb_per_sec += float(mb_value) if mb_value else 0
                else:
                    # Handle single producer result
                    test_summary = producer_result.get("test_summary", {})
                    mb_value = test_summary.get("mb_per_sec", 0)
                    total_mb_per_sec = float(mb_value) if mb_value else 0
                
                # Validate we have throughput data
                if total_mb_per_sec == 0:
                    logger.warning("No valid throughput data found in producer results")
                    return 0  # Will trigger skip if using less-than condition
                
                # Get requested throughput from current test parameters
                requested_throughput = float(event.get("current_test", {})
                                          .get("parameters", {})
                                          .get("cluster_throughput_mb_per_sec", 1))
                
                if requested_throughput == 0:
                    logger.warning("Requested throughput is 0, defaulting to 1")
                    requested_throughput = 1
                
                ratio = total_mb_per_sec / requested_throughput
                logger.info(f"Throughput ratio: {ratio:.2f} "
                          f"(achieved: {total_mb_per_sec:.2f}, "
                          f"requested: {requested_throughput:.2f})")
                return ratio
            else:
                raise ValueError(f"Unknown condition string: {condition}")
        
        elif isinstance(condition, (int, float)):
            return condition
        
        else:
            raise ValueError(f"Invalid condition type: {type(condition)}")

    # Error handling         
    except Exception as e:
        logger.error(f"Error in evaluate_skip_condition: {str(e)}")
        raise

# Function that handles the progression through test parameters
def increment_test_index(index, event, pos):
    try:
        # Parameter initialization
        parameters = [key for key in event["test_specification"]["parameters"].keys()]
        
        if not (0 <= pos < len(parameters)):
            raise OverflowError("All test combinations exhausted")

        parameter_name = parameters[pos]
        parameter_value = event["current_test"]["index"][parameter_name]
        parameter_options = event["test_specification"]["parameters"][parameter_name]

        logger.info(f"Current parameter: {parameter_name}, value: {parameter_value}, options: {parameter_options}")
        logger.info(f"Current index state: {json.dumps(index, indent=2)}")

        # Parameter value increment logic
        if (parameter_value + 1 < len(parameter_options)):
            # Keep the same throughput series ID if we're just incrementing throughput
            if parameter_name == "cluster_throughput_mb_per_sec":
                new_index = {**index, parameter_name: parameter_value + 1}
                current_series_id = event["current_test"]["parameters"]["throughput_series_id"]
                logger.info(f"Incrementing throughput, keeping series ID: {current_series_id}")
                return (new_index, current_series_id)
            else:
                # Generate new throughput series ID for other parameter changes
                new_series_id = random.randint(0,100000)
                logger.info(f"Parameter change, generating new series ID: {new_series_id}")
                return ({**index, parameter_name: parameter_value + 1}, new_series_id)
        # Parameter reset and recursion
        else:
            if parameter_name == "cluster_throughput_mb_per_sec":
                logger.info("Resetting throughput and moving to next parameter")
                (updated_index, _) = increment_test_index({**index, parameter_name: 0}, event, pos+1)
                new_series_id = random.randint(0,100000)
                logger.info(f"Generated new series ID: {new_series_id}")
                return (updated_index, new_series_id)
            else:
                return increment_test_index({**index, parameter_name: 0}, event, pos+1)
    
    # Error handling  
    except Exception as e:
        logger.error(f"Error in increment_test_index: {str(e)}")
        raise

# Function that prepares teh test parameters for execution
def update_parameters(test_specification, updated_test_index, test_id, throughput_series_id):
    try:
        if updated_test_index is None:
            return {"test_specification": test_specification}

        logger.info(f"Updating parameters with test_id: {test_id}, series_id: {throughput_series_id}")
        logger.info(f"Updated test index: {updated_test_index}")

        # Get actual parameter values, not indices
        updated_parameters = {
            param_name: test_specification["parameters"][param_name][index] 
            for param_name, index in updated_test_index.items()
        }
        
        logger.info(f"Updated parameters: {updated_parameters}")

        # Get client props from the array
        client_props = updated_parameters["client_props"]
        if isinstance(client_props, list):
            client_props = client_props[0]

        # Get consumer groups info
        consumer_groups = updated_parameters["consumer_groups"]
        if isinstance(consumer_groups, list):
            consumer_groups = consumer_groups[0]

        # Calculate num_jobs first
        num_jobs = updated_parameters["num_producers"] + (
                   consumer_groups["num_groups"] * 
                   consumer_groups["size"])

        record_size_byte = updated_parameters["record_size_byte"]
        cluster_throughput = updated_parameters["cluster_throughput_mb_per_sec"]

        # Throughput calculations
        if cluster_throughput > 0:
            producer_throughput_byte = (cluster_throughput * 1024 * 1024) // updated_parameters["num_producers"]
            consumer_throughput_byte = (cluster_throughput * 1024 * 1024) // consumer_groups["size"] if consumer_groups["size"] > 0 else 0
            num_records_producer = producer_throughput_byte * updated_parameters["duration_sec"] // record_size_byte
            num_records_consumer = consumer_throughput_byte * updated_parameters["duration_sec"] // record_size_byte
            
            logger.info(f"Throughput calculations: cluster={cluster_throughput}MB/s, producer={producer_throughput_byte}B/s")
        else:
            # Default values for unlimited throughput
            producer_throughput_byte = -1
            consumer_throughput_byte = -1
            num_records_producer = 2147483647
            num_records_consumer = 2147483647

        # Topic name generation
        topic_name = f'test-{test_id}-series-{throughput_series_id}-' + '-'.join([
            f"t{cluster_throughput}",
            f"p{updated_parameters['num_producers']}",
            f"part{updated_parameters['num_partitions']}",
            f"s{record_size_byte}",
            f"r{updated_parameters['replication_factor']}",
            f"d{updated_parameters['duration_sec']}",
            f"cg{consumer_groups['num_groups']}",
            f"cs{consumer_groups['size']}"
        ])

        # Ensure topic name is valid for Kafka
        topic_name = re.sub(r'[^a-zA-Z0-9._-]', '-', topic_name)
        depletion_topic_name = f'test-{test_id}-series-{throughput_series_id}-depl'
        depletion_topic_name = re.sub(r'[^a-zA-Z0-9._-]', '-', depletion_topic_name)

        logger.info(f"Generated topic name: {topic_name}")

        # Create parameters dictionary with numeric values for AWS Batch
        parameters = {
            "num_jobs": num_jobs,
            "replication_factor": updated_parameters["replication_factor"],
            "topic_name": topic_name,
            "depletion_topic_name": depletion_topic_name,
            "record_size_byte": record_size_byte,
            "records_per_sec": max(1, producer_throughput_byte // record_size_byte),
            "num_partitions": updated_parameters["num_partitions"],
            "duration_sec": updated_parameters["duration_sec"],
            "producer_throughput": producer_throughput_byte,
            "num_records_producer": num_records_producer,
            "num_records_consumer": num_records_consumer,
            "test_id": test_id,
            "throughput_series_id": throughput_series_id,
            "num_producers": updated_parameters["num_producers"],
            "num_consumer_groups": consumer_groups["num_groups"],
            "size_consumer_group": consumer_groups["size"],
            "producer_props": client_props["producer"],
            "consumer_props": client_props["consumer"],
            "cluster_throughput_mb_per_sec": cluster_throughput,
            "client_props": {
                "producer": client_props["producer"],
                "consumer": client_props["consumer"]
            },
            "consumer_groups": {
                "num_groups": consumer_groups["num_groups"],
                "size": consumer_groups["size"]
            }
        }

        result = {
            "test_specification": test_specification,
            "current_test": {
                "index": updated_test_index,
                "parameters": parameters
            }
        }

        logger.info(f"Final result: {json.dumps(result, indent=2)}")
        return result

    # Error handling  
    except Exception as e:
        logger.error(f"Error in update_parameters: {str(e)}")
        raise

# Function that handles the skip condition logic
def skip_remaining_throughput(index, event):
    try:
        # Get current consumer groups value
        current_consumer_groups_index = index.get("consumer_groups", 0)
        consumer_groups_options = event["test_specification"]["parameters"]["consumer_groups"]
        
        # Check if we can increment consumer_groups
        if current_consumer_groups_index + 1 < len(consumer_groups_options):
            # Create new index, keeping all values except resetting throughput and incrementing consumer_groups
            new_index = index.copy()  # Keep the original index values
            new_index["cluster_throughput_mb_per_sec"] = 0
            new_index["consumer_groups"] = current_consumer_groups_index + 1
            
            # Generate new series ID for the new consumer group
            new_series_id = random.randint(0, 100000)
            
            logger.info(f"Moving to next consumer group: {new_index['consumer_groups']}")
            logger.info(f"Generated new series ID: {new_series_id}")
            
            return (new_index, new_series_id)
        else:
            # No more consumer groups
            logger.info("No more consumer groups available")
            raise OverflowError("All consumer groups tested")
    
    # Error handling 
    except Exception as e:
        logger.error(f"Error in skip_remaining_throughput: {str(e)}")
        raise

# Function that manages the parameters for credit depletion
def update_parameters_for_depletion(event, context):
    try:
        # Parameter extraction
        test_specification = event["test_specification"]
        test_parameters = test_specification["parameters"]
        test_index = event["current_test"]["index"]
        test_id = event["current_test"]["parameters"]["test_id"]
        throughput_series_id = event["current_test"]["parameters"]["throughput_series_id"]
        depletion_duration_sec = test_specification["depletion_configuration"]["approximate_timeout_hours"] * 60 * 60

        logger.info(f"Updating depletion parameters for test_id: {test_id}, series_id: {throughput_series_id}")

        # Get the current parameters
        current_parameters = event["current_test"]["parameters"].copy()
        
        # Update parameters for depletion test
        current_parameters.update({
            "duration_sec": depletion_duration_sec,
            "records_per_sec": -1,  # Unlimited throughput for depletion
            "num_records_producer": 2147483647,  # Max integer value
            "num_records_consumer": 0,  # No consumers in depletion test
            "num_jobs": int(current_parameters["num_producers"]),  # Set num_jobs to number of producers
            "test_id": test_id,
            "throughput_series_id": throughput_series_id,
            "depletion_topic_name": f'test-{test_id}-series-{throughput_series_id}-depl'
        })

        # Results formation
        result = {
            "test_specification": test_specification,
            "current_test": {
                "index": test_index,
                "parameters": current_parameters
            }
        }

        logger.info(f"Depletion parameters: {json.dumps(result, indent=2)}")
        return result

    # Error handling 
    except Exception as e:
        logger.error(f"Error in update_parameters_for_depletion: {str(e)}")
        raise
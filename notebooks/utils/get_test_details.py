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
import json
import datetime
import collections
from pprint import pprint

# Collects and organizes test execution details from AWS Step Functions and CloudFormation
def get_test_details(test_params, stepfunctions, cloudformation):
    sfn_status = []
    test_details = []

    # Fallback mechanism for test parameters that don't require AWS Step Functions querying
    for test_param in test_params:
        if 'execution_arn' not in test_param:
            test_details.append(test_param)
            continue

        # ARN Preparation and API call
        execution_arn = test_param['execution_arn'].strip()
        execution_details = stepfunctions.describe_execution(executionArn=execution_arn)

        # Stop Date Check
        if 'stopDate' in execution_details:
            stop_date = execution_details['stopDate']
        else:
            # If the workflow is still running, just query everything up until now
            stop_date = datetime.datetime.now()
                
        # Extract CloudFormation stack name from Step Functions execution ARN
        stack_name = test_param['execution_arn'].split(':')[-2]        # Get state machine name
        stack_name = stack_name.replace('-State-Machine-main', '')     # Remove both -State-Machine-main suffixes
        
        # Obtain the name of the CloudWatch Log Group containing all test results from CloudFormation stack outputs
        stack_details = cloudformation.describe_stacks(StackName=stack_name)
        log_group_name = next(filter(lambda x: x['OutputKey']=='LogGroupName', stack_details['Stacks'][0]['Outputs']))['OutputValue']

        # Get cluster properties by analyzing the CloudFormation stack template
        try:
            stack_details = cloudformation.describe_stacks(StackName=stack_name)
            stack_template = cloudformation.get_template(StackName=stack_name)
            
            # Convert OrderedDict to regular dict
            template_body = json.loads(json.dumps(stack_template['TemplateBody']))
            
            # Extract MSK cluster properties from the template
            msk_cluster = next((resource for resource in template_body['Resources'].values() 
                              if resource['Type'] == 'AWS::MSK::Cluster'), None)
            
            if msk_cluster:
                cluster_props = msk_cluster['Properties']
                broker_props = cluster_props['BrokerNodeGroupInfo']
                
                # Extract encryption settings
                encryption_info = cluster_props.get('EncryptionInfo', {})
                encryption_in_transit = encryption_info.get('EncryptionInTransit', {})
                
                # Handle CloudFormation Ref for cluster name
                cluster_name = cluster_props['ClusterName']
                if isinstance(cluster_name, dict) and 'Ref' in cluster_name:
                    if cluster_name['Ref'] == 'AWS::StackName':
                        cluster_name = stack_name
                
                # Dictionary of MSK cluster properties
                cluster_properties = {
                    'cluster_name': cluster_name,
                    'cluster_id': stack_name,
                    'num_brokers': cluster_props['NumberOfBrokerNodes'],
                    'broker_type': broker_props['InstanceType'],
                    'broker_storage': broker_props['StorageInfo']['EBSStorageInfo']['VolumeSize'],
                    'in_cluster_encryption': 't' if encryption_in_transit.get('InCluster', False) else 'f',
                    'kafka_version': cluster_props['KafkaVersion'],
                    'provisioned_throughput': broker_props['StorageInfo']['EBSStorageInfo'].get('ProvisionedThroughput', 0)
                }
            # Error handling
            else:
                print(f"Warning: No MSK cluster found in stack {stack_name}")
                raise ValueError(f"No MSK cluster found in stack {stack_name}")
                
        except Exception as e:
            print(f"Error getting cluster properties from CloudFormation: {str(e)}")
            raise
        
        # Dictionary containing test execution details
        input_json = json.loads(execution_details['input'])
        status = {
            'log_group_name': log_group_name,
            'start_date': execution_details['startDate'],
            'stop_date': stop_date,
            'test_parameters': input_json['test_specification']['parameters'],
            'cluster_properties': cluster_properties
        }

        # Test execution status tracking
        if execution_details['status'] == 'RUNNING':
            status['execution_arn'] = test_param['execution_arn'] 

        # Status collection
        test_details.append(status)
        sfn_status.append(execution_details['status'])

    # Print status summary
    if len(sfn_status) > 0:
        print(f"Step Functions workflow status: {dict(collections.Counter(sfn_status))}")
        
        # Print test details using the pprint module for better formatting
        print()
        for test_detail in test_details:
            print("test_params.extend([")
            pprint(test_detail, indent=4, width=100)
            print("])")
            print()

    # Return the collected test details back to the calling function
    return test_details
// Copyright 2025 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// 
// Permission is hereby granted, free of charge, to any person obtaining a copy of
// this software and associated documentation files (the "Software"), to deal in
// the Software without restriction, including without limitation the rights to
// use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
// the Software, and to permit persons to whom the Software is furnished to do so.
// 
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
// FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
// COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
// IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
// CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

// AWS CDK import definitions
import { Construct } from 'constructs';
import * as path from 'path';
import {
    Aws,
    StackProps,
    Duration,
    aws_iam as iam,
    aws_stepfunctions as sfn,
    aws_stepfunctions_tasks as tasks,
    aws_lambda as lambda,
    aws_batch as batch
} from 'aws-cdk-lib';
import { IntegrationPattern } from 'aws-cdk-lib/aws-stepfunctions';
import { NodejsFunction, NodejsFunctionProps, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';

// Interface definition that defines parameters for credit depletion testing
export interface CreditDepletionParameters extends StackProps {
    clusterName: string;
    jobDefinition: batch.CfnJobDefinition;
    jobQueue: batch.CfnJobQueue;
    commandParameters: string[];
    payload: sfn.TaskInput;
}
// Class declaration
export class CreditDepletion extends Construct {
    public readonly stateMachine: sfn.StateMachine;

    // Constructor definition
    constructor(scope: Construct, id: string, props: CreditDepletionParameters) {
        super(scope, id);

        const fail = new sfn.Fail(this, 'FailDepletion');
        const succeed = new sfn.Succeed(this, 'SucceedDepletion');

        // Common bundling options
        const bundlingOptions: NodejsFunctionProps['bundling'] = {
            minify: true,
            sourceMap: true,
            target: 'node20',
            format: OutputFormat.CJS,  
            metafile: true,
            mainFields: ['module', 'main'],
            externalModules: ['@aws-sdk/*'],
            environment: {
                NODE_OPTIONS: '--enable-source-maps'
            }
        };

        // Lambda function definition that handles credit depletion termination
        const terminateCreditDepletionLambda = new NodejsFunction(this, 'TerminateCreditDepletionLambda', {
            entry: path.join(__dirname, '../lambda/manage-infrastructure.js'),
            handler: 'terminateDepletionJob',
            runtime: lambda.Runtime.NODEJS_20_X,
            bundling: bundlingOptions,
            timeout: Duration.seconds(5),
            environment: {
                NODE_OPTIONS: '--enable-source-maps'
            }
        });

        // Lambda function definition that queries MSK cluster throughput
        const queryClusterThroughputLambda = new NodejsFunction(this, 'QueryClusterThroughputLambda', {
            entry: path.join(__dirname, '../lambda/manage-infrastructure.js'),
            handler: 'queryMskClusterThroughput',
            runtime: lambda.Runtime.NODEJS_20_X,
            bundling: bundlingOptions,
            timeout: Duration.seconds(5),
            environment: {
                MSK_CLUSTER_NAME: props.clusterName,
                NODE_OPTIONS: '--enable-source-maps'
            }
        });

        // IAM policy configuration for the terminate credit depletion Lambda function
        terminateCreditDepletionLambda.addToRolePolicy(
            new iam.PolicyStatement({
                actions: ['batch:TerminateJob'],
                resources: ['*']
            })
        );
      
        // IAM policy configuration for the MSK cluster throughput query Lambda
        queryClusterThroughputLambda.addToRolePolicy(
            new iam.PolicyStatement({
                actions: [
                    'cloudwatch:GetMetricData',
                    'batch:DescribeJobs'
                ],
                resources: ['*']
            })
        );

        // Choise state definition
        const checkAllJobsRunning = new sfn.Choice(this, 'CheckAllJobsRunning')
            // Main condition
            .when(sfn.Condition.numberGreaterThan('$.cluster_throughput.Payload.succeededPlusFailedJobs', 0), fail)
            // Default path
            .otherwise(succeed);

        // Termination task
        const terminateCreditDepletion = new tasks.LambdaInvoke(this, 'TerminateCreditDepletion', {
            lambdaFunction: terminateCreditDepletionLambda,
            inputPath: '$.depletion_job',
            resultPath: sfn.JsonPath.DISCARD
        });

        // State machine transition definition
        terminateCreditDepletion.next(checkAllJobsRunning);
      
        // Lambda invoke task definition for querying cluster throughput
        const queryClusterThroughputLowerThan = new tasks.LambdaInvoke(this, 'QueryClusterThroughputLowerThan', {
            lambdaFunction: queryClusterThroughputLambda,
            inputPath: '$',
            resultPath: '$.cluster_throughput'
          });
      
        // Wait state definition
        const waitThroughputLowerThan = new sfn.Wait(this, 'WaitThroughputLowerThan', {
            time: sfn.WaitTime.duration(Duration.minutes(1))
        });
      
        // Pause and check cluster throughput
        waitThroughputLowerThan.next(queryClusterThroughputLowerThan);
      
        // Choice state definition
        const checkThroughputLowerThan = new sfn.Choice(this, 'CheckThroughputLowerThanThreshold')
            // First condition
            .when(sfn.Condition.numberGreaterThan('$.cluster_throughput.Payload.succeededPlusFailedJobs', 0), terminateCreditDepletion)
            // Second condition
            .when(
                sfn.Condition.and(
                    // Cluster total throughput check
                    sfn.Condition.numberLessThanJsonPath('$.cluster_throughput.Payload.clusterMbInPerSec', '$.test_specification.depletion_configuration.lower_threshold.mb_per_sec'),
                    // Broker throughput standard deviation check                  
                    // sfn.Condition.numberLessThanJsonPath('$.cluster_throughput.Payload.brokerMbInPerSecStddev', '$.test_specification.depletion_configuration.lower_threshold.max_broker_stddev')
                ), 
                terminateCreditDepletion
            )
            // Default path
            .otherwise(waitThroughputLowerThan);
      
        // State machine transition definition
        queryClusterThroughputLowerThan.next(checkThroughputLowerThan);
      
        // Lambda invoke task definition
        const queryClusterThroughputExceeded = new tasks.LambdaInvoke(this, 'QueryClusterThroughputExceeded', {
            lambdaFunction: queryClusterThroughputLambda,
            inputPath: '$',
            resultPath: '$.cluster_throughput'
        });
      
        // Wait state definition
        const waitThroughputExceeded = new sfn.Wait(this, 'WaitThroughputExceeded', {
            time: sfn.WaitTime.duration(Duration.minutes(1))
        });
      
        // State machine transition definition
        waitThroughputExceeded.next(queryClusterThroughputExceeded);

        // Choice state definition that checks for the presence of a lower threshold configuration
        const checkLowerThanPresent = new sfn.Choice(this, 'CheckLowerThanPresent')
            // Main condition
            .when(sfn.Condition.isPresent('$.test_specification.depletion_configuration.lower_threshold.mb_per_sec'), waitThroughputLowerThan)
            // Default path
            .otherwise(terminateCreditDepletion);
      
        // Choice state that checks cluster throughput against upper thresholds
        const checkThroughputExceeded = new sfn.Choice(this, 'CheckThroughputExceeded')
            // First condition 
            .when(sfn.Condition.numberGreaterThan('$.cluster_throughput.Payload.succeededPlusFailedJobs', 0), terminateCreditDepletion)
            // Second condition 
            .when(sfn.Condition.numberGreaterThanJsonPath('$.cluster_throughput.Payload.clusterMbInPerSec', '$.test_specification.depletion_configuration.upper_threshold.mb_per_sec'), checkLowerThanPresent)
            // Default path
            .otherwise(waitThroughputExceeded);
      
        // State machine transition definition
        queryClusterThroughputExceeded.next(checkThroughputExceeded);
      
        // AWS Batch job submission task
        const submitCreditDepletion = new tasks.BatchSubmitJob(this, 'SubmitCreditDepletion', {
            jobName: 'RunCreditDepletion',
            jobDefinitionArn: props.jobDefinition.ref,
            jobQueueArn: props.jobQueue.attrJobQueueArn,
            arraySize: sfn.JsonPath.numberAt('$.current_test.parameters.num_jobs'),
            containerOverrides: {
                command: [...props.commandParameters, '--command', 'deplete-credits' ]
            },
            payload: props.payload,
            integrationPattern: IntegrationPattern.REQUEST_RESPONSE,
            inputPath: '$',
            resultPath: '$.depletion_job',
        });
        
        // State machine transition definition
        submitCreditDepletion.next(waitThroughputExceeded);

        // Lambda function definition
        const updateDepletionParameterLambda = new lambda.Function(this, 'UpdateDepletionParameterLambda', { 
            runtime: lambda.Runtime.PYTHON_3_8,
            code: lambda.Code.fromAsset('lambda'),
            timeout: Duration.seconds(5),
            handler: 'test-parameters.update_parameters_for_depletion',
        });
    
        // Lambda invoke task definition
        const updateDepletionParameter = new tasks.LambdaInvoke(this, 'UpdateDepletionParameter', {
            lambdaFunction: updateDepletionParameterLambda,
            outputPath: '$.Payload',
        });

        // State machine transition definition
        updateDepletionParameter.next(submitCreditDepletion);
  
        // Choice state that determines if credit depletion testing is required
        const checkDepletion = new sfn.Choice(this, 'CheckDepletionRequired')
            // Main condition
            .when(sfn.Condition.isNotPresent('$.test_specification.depletion_configuration'), succeed)
            // Default path 
            .otherwise(updateDepletionParameter);
      
        // Step Functions state machine definition
        this.stateMachine = new sfn.StateMachine(this, 'DepleteCreditsStateMachine', {
            definitionBody: sfn.DefinitionBody.fromChainable(checkDepletion),
            stateMachineName: `${Aws.STACK_NAME}-credit-depletion`, 
        });             
    }
}
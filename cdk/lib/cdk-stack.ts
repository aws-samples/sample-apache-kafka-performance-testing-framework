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

// External packages
import { Construct } from 'constructs';
import * as path from 'path';

// AWS CDK core
import {
  Aws,
  Stack,
  StackProps,
  CfnResource,
  CfnOutput,
  Duration,
  RemovalPolicy
} from 'aws-cdk-lib';

// AWS CDK services inport definitions
import * as batch from 'aws-cdk-lib/aws-batch';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { DockerImageAsset, Platform } from 'aws-cdk-lib/aws-ecr-assets';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import * as sagemaker from 'aws-cdk-lib/aws-sagemaker';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { IntegrationPattern, TaskInput } from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { AwsCustomResource, AwsCustomResourcePolicy } from 'aws-cdk-lib/custom-resources';
import { CfnCluster } from 'aws-cdk-lib/aws-msk';

// MSK Alpha package
import * as msk from '@aws-cdk/aws-msk-alpha';
import { ClusterMonitoringLevel, StorageMode, KafkaVersion } from '@aws-cdk/aws-msk-alpha';

// Local imports
import { CreditDepletion } from './credit-depletion-sfn';

// Interface that defines parameters for creating a new MSK cluster
export interface MskClusterParametersNewCluster extends StackProps {
  // Core MSK cluster configuration
  clusterProps: {
    numberOfBrokerNodes: number,    
    instanceType: ec2.InstanceType,
    // EBS storage configuration
    ebsStorageInfo: {
      volumeSize: number,
      provisionedThroughput?: {
        enabled: boolean,
        volumeThroughput: number
      }
    },
    // Security settings
    encryptionInTransit: msk.EncryptionInTransitConfig,
    clientAuthentication?: msk.ClientAuthentication,
    // Kafka-specific settings
    kafkaVersion: KafkaVersion,
    configurationInfo?: msk.ClusterConfigurationInfo
  },
  // Networking
  vpc?: ec2.IVpc,
  sg?: ec2.ISecurityGroup,
  // Performance testing configuration
  initialPerformanceTest?: any,
  jobDefinition?: batch.CfnJobDefinition,
  jobQueue?: batch.CfnJobQueue,
  commandParameters?: string[],
  payload?: sfn.TaskInput
}
// Interface that defines parameters for connecting to an existing MSK cluster
export interface BootstrapBroker extends StackProps {
  // Core MSK connection details
  bootstrapBrokerString: string,
  clusterName: string,
  // Networking configuration
  vpc?: ec2.IVpc | string,
  sg: ec2.ISecurityGroup | string,
  // Performance testing configuration
  initialPerformanceTest?: any,
  // AWS Batch integration
  jobDefinition?: batch.CfnJobDefinition,
  jobQueue?: batch.CfnJobQueue,
  // Test parameters
  commandParameters?: string[],
  payload?: sfn.TaskInput
}

// Function that generates a stack name based on MSK cluster parameters
function toStackName(params: MskClusterParametersNewCluster | BootstrapBroker, prefix: string) : string {
  // Check if using existing cluster
  if ('bootstrapBrokerString' in params) {
    return prefix
  } else {
    // Generate name for new cluster based on its properties
    const brokerNodeType = params.clusterProps.instanceType.toString().replace(/[^0-9a-zA-Z]/g, '');
    const inClusterEncryption = params.clusterProps.encryptionInTransit.enableInCluster ? "t" : "f"
    const clusterVersion = params.clusterProps.kafkaVersion.version.replace(/[^0-9a-zA-Z]/g, '');
    const numSubnets = params.vpc ? Math.max(params.vpc.privateSubnets.length, 3) : 3;
    const name = `${params.clusterProps.numberOfBrokerNodes*numSubnets}-${brokerNodeType}-${params.clusterProps.ebsStorageInfo.volumeSize}-${inClusterEncryption}-${clusterVersion}`;

    return `${prefix}${name}`;
  }
}

// CDK Stack class definition
export class CdkStack extends Stack {
  constructor(scope: Construct, id: string, props: MskClusterParametersNewCluster | BootstrapBroker) {
    super(scope, id, props);
    
    // VPC Configuration
    var vpc;
    if (props.vpc) {
      // If VPC is provided
      if (typeof props.vpc === "string") {
        // If VPC is provided as string (VPC ID)
        vpc = ec2.Vpc.fromLookup(this, 'Vpc', { vpcId: props.vpc })
      } else {
        // If VPC is provided as VPC object
        vpc = props.vpc
      }
    } else {
      // If no VPC provided, create new one
      vpc = new ec2.Vpc(this, 'Vpc');
    }

    // Security Group Configuration
    var sg;
    if (props.sg) {
      // If Security Group is provided
      if (typeof props.sg === "string") {
        // If Security Group is provided as string (Security Group ID)
        sg = ec2.SecurityGroup.fromSecurityGroupId(this, 'SecurityGroup', props.sg)
      } else {
        // If Security Group is provided as Security Group object
        sg = props.sg
      }
    } else {
      // If no Security Group provided, create new one
      sg = new ec2.SecurityGroup(this, 'SecurityGroup', { vpc: vpc });
      sg.addIngressRule(sg, ec2.Port.allTraffic()); // Allow all inbound traffic
    }
    
    // Kafka cluster type definition
    var kafka : { cfnCluster?: CfnResource, numBrokers?: number, clusterName: string };

    // Branch based on whether we're using existing or new cluster
    if ('bootstrapBrokerString' in props) {
      // Using existing cluster - only need cluster name
      kafka = {
        clusterName: props.clusterName
      };
    } else {
      // Creating new cluster
      // Destructure EBS storage info from other cluster properties
      const { ebsStorageInfo, ...restClusterProps } = props.clusterProps;
      
      // Create new MSK cluster
      const cluster = new msk.Cluster(this, 'KafkaCluster', {
        ...restClusterProps,                          // Spread other cluster properties
        monitoring: {
          clusterMonitoringLevel: ClusterMonitoringLevel.PER_BROKER
        },
        vpc: vpc,                                     // Use configured VPC
        vpcSubnets: {
          subnetType: ec2.SubnetType.PRIVATE_WITH_NAT // Use private subnets
        },
        securityGroups: [ sg ],                       // Use configured security group
        clusterName: Aws.STACK_NAME,                  // Use stack name as cluster name
        removalPolicy: RemovalPolicy.DESTROY          // Delete cluster when stack is deleted
    });

      // Get underlying CloudFormation resource
      const cfnCluster = cluster.node.findChild('Resource') as CfnCluster;

      // Configure EBS storage based on provisioned throughput setting
      if (ebsStorageInfo.provisionedThroughput?.enabled) {
        // Configure for provisioned IOPS
        cfnCluster.addPropertyOverride('StorageMode', 'TIERED');
        cfnCluster.addPropertyOverride('BrokerNodeGroupInfo.StorageInfo', {
          EBSStorageInfo: {
            VolumeSize: ebsStorageInfo.volumeSize,
            ProvisionedThroughput: {
              Enabled: true,
              VolumeThroughput: ebsStorageInfo.provisionedThroughput.volumeThroughput
            }
          }
        });
      } else {
        // Configure for standard storage
        cfnCluster.addPropertyOverride('BrokerNodeGroupInfo.StorageInfo', {
          EBSStorageInfo: {
            VolumeSize: ebsStorageInfo.volumeSize
          }
        });
      }

      kafka = {
        // Store the CloudFormation cluster resource
        cfnCluster: cfnCluster,
        // Calculate total number of broker nodes
        numBrokers: Math.max(vpc.privateSubnets.length, 3) * props.clusterProps.numberOfBrokerNodes,
        // Store the cluster name
        clusterName: cluster.clusterName
      }
    }

    // Create a log group for default logs with 1-week retention
    const defaultLogGroup = new logs.LogGroup(this, 'DefaultLogGroup', {
      retention: RetentionDays.ONE_WEEK
    });

    // Create a log group for performance test logs with 1-year retention
    const performanceTestLogGroup = new logs.LogGroup(this, 'PerformanceTestLogGroup', {
      retention: RetentionDays.ONE_YEAR
    });

    // Batch ECS instance role
    const batchEcsInstanceRole = new iam.Role(this, 'BatchEcsInstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        // ECS container service role
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonEC2ContainerServiceforEC2Role'),
        // Systems Manager access
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')
      ]
    });

    // Batch ECS instance
    const batchEcsInstanceProfile = new iam.CfnInstanceProfile(this, 'BatchEcsInstanceProfile', {
      roles: [ batchEcsInstanceRole.roleName ],
    });

    // Batch compute environment
    const computeEnvironment = new batch.CfnComputeEnvironment(this, 'ComputeEnvironment', {
      computeEnvironmentName: `${Aws.STACK_NAME}-batch-ce`,
      type: 'MANAGED',
      state: 'ENABLED',
      computeResources: {
        type: 'EC2',
        maxvCpus: 256,
        minvCpus: 0,
        desiredvCpus: 0,
        instanceTypes: ['c5n.large'],
        subnets: vpc.privateSubnets.map(subnet => subnet.subnetId),
        instanceRole: batchEcsInstanceProfile.attrArn,
        securityGroupIds: [sg.securityGroupId],
      },
    });

    // Job queue configuration
    const jobQueue = new batch.CfnJobQueue(this, 'JobQueue', {
      jobQueueName: Aws.STACK_NAME,
      priority: 1,
      state: 'ENABLED',
      computeEnvironmentOrder: [
        {
          computeEnvironment: computeEnvironment.attrComputeEnvironmentArn,
          order: 1,
        },
      ],
    });

    // Job role with MSK permissions
    const jobRole = new iam.Role(this, 'JobRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('ReadOnlyAccess')
      ],
      inlinePolicies: {
        TerminateJob: new iam.PolicyDocument({
          statements: [
            // Batch job termination permission
            new iam.PolicyStatement({
              actions: ["batch:TerminateJob"],
              resources: ["*"]
            }),
            // MSK cluster connection permissions
            new iam.PolicyStatement({
              actions: [
                "kafka-cluster:Connect",
                "kafka-cluster:DescribeCluster"
              ],
              resources: [`arn:${Aws.PARTITION}:kafka:${Aws.REGION}:${Aws.ACCOUNT_ID}:cluster/${kafka.clusterName}/*`]
            }),
            // MSK topic permissions
            new iam.PolicyStatement({
              actions: [
                "kafka-cluster:*Topic*",
                "kafka-cluster:WriteData",
                "kafka-cluster:ReadData"
              ],
              resources: [`arn:${Aws.PARTITION}:kafka:${Aws.REGION}:${Aws.ACCOUNT_ID}:topic/${kafka.clusterName}/*`]
            }),
            // MSK consumer group permissions
            new iam.PolicyStatement({
              actions: [
                "kafka-cluster:AlterGroup",
                "kafka-cluster:DescribeGroup"
              ],
              resources: [`arn:${Aws.PARTITION}:kafka:${Aws.REGION}:${Aws.ACCOUNT_ID}:group/${kafka.clusterName}/*`]
            })
          ]
        })
      }
    });

    // Docker image asset definition
    const dockerImageAsset = new DockerImageAsset(this, 'BuildImage', {
      directory: path.join(__dirname, '../docker'),
      platform: Platform.LINUX_AMD64,
    });
    
    // IAM role definition for AWS Batch execution
    const executionRole = new iam.Role(this, 'BatchExecutionRole', {
      // Trust relationship
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal('batch.amazonaws.com'),
        new iam.ServicePrincipal('ecs-tasks.amazonaws.com')
      ),
      // Managed policies
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSBatchServiceRole'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy')
      ]
    });

    // IAM role definition for AWS Batch jobs
    const batchJobRole = new iam.Role(this, 'BatchJobRole', {
      // Trust relationship
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal('batch.amazonaws.com'),
        new iam.ServicePrincipal('ecs-tasks.amazonaws.com')
      ),
      // Managed policies
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy')
      ],
      // Custom MSK permissions
      inlinePolicies: {
        MSKAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                "kafka:GetBootstrapBrokers",
                "kafka:DescribeCluster",
                "kafka:DescribeClusterV2"
              ],
              resources: [`arn:${Aws.PARTITION}:kafka:${Aws.REGION}:${Aws.ACCOUNT_ID}:cluster/${kafka.clusterName}/*`]
            }),
            // Batch Job Permissions
            new iam.PolicyStatement({
              actions: [
                "batch:ListJobs"
              ],
              resources: ["*"] 
            })
          ]
        })
      }
    });

    // AWS Batch performance test job definition configuration
    const performanceTestJobDefinition = new batch.CfnJobDefinition(this, 'PerformanceTestJobDefinition', {
      type: 'container',
      containerProperties: {
          image: dockerImageAsset.imageUri,
          vcpus: 2,
          memory: 4900,
          command: [], 
          environment: [
          ],
          logConfiguration: {
              logDriver: 'awslogs',
              options: {
                  'awslogs-region': Aws.REGION,
                  'awslogs-group': performanceTestLogGroup.logGroupName,
                  'awslogs-stream-prefix': 'performance-test'
              }
          },
          jobRoleArn: batchJobRole.roleArn,
          executionRoleArn: executionRole.roleArn
      },
      platformCapabilities: ['EC2'],
      retryStrategy: {
          attempts: 1
      }
    });
  
    // AWS Batch default job definition configuration
    const defaultJobDefinition = new batch.CfnJobDefinition(this, 'DefaultJobDefinition', {
      type: 'container',
      containerProperties: {
          image: dockerImageAsset.imageUri,
          vcpus: 2,
          memory: 4900,
          command: [],
          environment: [
          ],
          logConfiguration: {
              logDriver: 'awslogs',
              options: {
                  'awslogs-region': Aws.REGION,
                  'awslogs-group': defaultLogGroup.logGroupName,
                  'awslogs-stream-prefix': 'default'
              }
          },
          jobRoleArn: batchJobRole.roleArn,
          executionRoleArn: executionRole.roleArn
      },
      platformCapabilities: ['EC2'],
      retryStrategy: {
          attempts: 1
      }
    });
    
    // Step Functions task input configuration
    const payload = TaskInput.fromObject({
      'num_jobs.$': 'States.JsonToString($.current_test.parameters.num_jobs)',
      'replication_factor.$': 'States.JsonToString($.current_test.parameters.replication_factor)',
      topic_name: sfn.JsonPath.stringAt('$.current_test.parameters.topic_name'),
      depletion_topic_name: sfn.JsonPath.stringAt('$.current_test.parameters.depletion_topic_name'),
      'record_size_byte.$': 'States.JsonToString($.current_test.parameters.record_size_byte)',
      'records_per_sec.$': 'States.JsonToString($.current_test.parameters.records_per_sec)',
      'num_partitions.$': 'States.JsonToString($.current_test.parameters.num_partitions)',
      'duration_sec.$': 'States.JsonToString($.current_test.parameters.duration_sec)',
      producer_props: sfn.JsonPath.stringAt('$.current_test.parameters.client_props.producer'),             
      'num_producers.$':  'States.JsonToString($.current_test.parameters.num_producers)',
      'num_records_producer.$': 'States.JsonToString($.current_test.parameters.num_records_producer)',
      consumer_props: sfn.JsonPath.stringAt('$.current_test.parameters.client_props.consumer'),
      'num_consumer_groups.$': 'States.JsonToString($.current_test.parameters.consumer_groups.num_groups)',
      'size_consumer_group.$': 'States.JsonToString($.current_test.parameters.consumer_groups.size)',
      'num_records_consumer.$': 'States.JsonToString($.current_test.parameters.num_records_consumer)',
    });

    // Command parameters array
    const commandParameters = [
      '--region', Aws.REGION,
      '--msk-cluster-arn', kafka.cfnCluster? kafka.cfnCluster.ref : '-',
      '--bootstrap-broker', 'bootstrapBrokerString' in props ? props.bootstrapBrokerString : '-',
      '--num-jobs', 'Ref::num_jobs',
      '--replication-factor', 'Ref::replication_factor',
      '--topic-name', 'Ref::topic_name',
      '--depletion-topic-name', 'Ref::depletion_topic_name',
      '--record-size-byte', 'Ref::record_size_byte',
      '--records-per-sec', 'Ref::records_per_sec',
      '--num-partitions', 'Ref::num_partitions',
      '--duration-sec', 'Ref::duration_sec',
      '--producer-props', 'Ref::producer_props',
      '--num-producers', 'Ref::num_producers',
      '--num-records-producer', 'Ref::num_records_producer',
      '--consumer-props', 'Ref::consumer_props',
      '--num-consumer-groups', 'Ref::num_consumer_groups',
      '--num-records-consumer', 'Ref::num_records_consumer',
      '--size-consumer-group', 'Ref::size_consumer_group'
    ]

    // Lambda function definition
    const queryProducerResultLambda = new lambda.Function(this, 'QueryProducerResultLambda', { 
      runtime: lambda.Runtime.NODEJS_20_X,
      code: lambda.Code.fromAsset('lambda'),
      timeout: Duration.minutes(2),
      handler: 'query-test-output.queryProducerOutput',
      environment: {
          LOG_GROUP_NAME: performanceTestLogGroup.logGroupName
      }
    });
  
    // Grant both FilterLogEvents and GetLogEvents permissions
    performanceTestLogGroup.grant(queryProducerResultLambda, 
        'logs:FilterLogEvents',
        'logs:GetLogEvents',
        'logs:DescribeLogStreams',
        'logs:DescribeLogGroups'
    );
  
    // IAM policy addition to the Lambda function
    queryProducerResultLambda.addToRolePolicy(
        new iam.PolicyStatement({
            actions: ['batch:DescribeJobs'],
            resources: ['*']
        })
    );
    
    // Step Functions Lambda invocation task
    const queryProducerResult = new tasks.LambdaInvoke(this, 'QueryProducerResult', {
        lambdaFunction: queryProducerResultLambda,
        resultPath: '$.producer_result',
        retryOnServiceExceptions: true,
        taskTimeout: sfn.Timeout.duration(Duration.minutes(2)),
        payloadResponseOnly: true
    });
    
    // Retry policy for CloudWatch Logs query issues
    queryProducerResult.addRetry({
        maxAttempts: 3,
        backoffRate: 2,
        interval: Duration.seconds(15),
        errors: ['Error', 'incomplete query results'],
        jitterStrategy: sfn.JitterType.FULL
    });

    // AWS Batch job submission task for running the performance test
    const runPerformanceTest = new tasks.BatchSubmitJob(this, 'RunPerformanceTest', {
      jobName: 'RunPerformanceTest',
      jobDefinitionArn: performanceTestJobDefinition.ref,
      jobQueueArn: jobQueue.attrJobQueueArn,
      arraySize: sfn.JsonPath.numberAt('$.current_test.parameters.num_jobs'),
      containerOverrides: {
        command: [...commandParameters, '--command', 'run-performance-test' ]
      },
      payload: payload,
      resultPath: '$.job_result',
    });

    // State machine transition definition
    runPerformanceTest.next(queryProducerResult);

    // Credit depletion configuration
    const depleteCreditsConstruct = new CreditDepletion(this, 'DepleteCreditsSfn', {
      clusterName: kafka.clusterName,
      jobDefinition: defaultJobDefinition,
      jobQueue: jobQueue,
      commandParameters: commandParameters,
      payload: payload        
    })

    // Step Functions execution task
    const depleteCredits = new tasks.StepFunctionsStartExecution(this, 'DepleteCredits', {
      stateMachine: depleteCreditsConstruct.stateMachine,
      integrationPattern: IntegrationPattern.RUN_JOB,
      inputPath: '$',
      resultPath: '$.null',
      taskTimeout: sfn.Timeout.duration(Duration.hours(6)) 
    });

    // State machine transition definition
    depleteCredits.next(runPerformanceTest);

    // AWS Batch job submission task for topic creation
    const createTopics = new tasks.BatchSubmitJob(this, 'CreateTopics', {
      jobName: 'CreateTopics',
      jobDefinitionArn: props.jobDefinition?.ref ?? defaultJobDefinition.ref,
      jobQueueArn: props.jobQueue?.attrJobQueueArn ?? jobQueue.attrJobQueueArn,
      containerOverrides: {
          command: [...(props.commandParameters ?? commandParameters), '--command', 'create-topics' ]
      },
      payload: props.payload ?? payload,
      resultPath: sfn.JsonPath.DISCARD
    });

    // State machine transition definition
    createTopics.next(depleteCredits);

    // Step Functions success state
    const finalState = new sfn.Succeed(this, 'Succeed');

    // Choise state definition
    const checkCompleted = new sfn.Choice(this, 'CheckAllTestsCompleted')
      // Main condition
      .when(sfn.Condition.isPresent('$.current_test'), createTopics)
      // Default path
      .otherwise(finalState);

    // Lambda function definition
    const updateTestParameterLambda = new lambda.Function(this, 'UpdateTestParameterLambda', {
      runtime: lambda.Runtime.PYTHON_3_8,
      code: lambda.Code.fromAsset('lambda'),
      timeout: Duration.seconds(5),
      handler: 'test-parameters.increment_index_and_update_parameters',
    });

    // Step Functions Lambda invocation task
    const updateTestParameter = new tasks.LambdaInvoke(this, 'UpdateTestParameter', {
      lambdaFunction: updateTestParameterLambda,
      outputPath: '$.Payload',
    });

    // State machine transition definition
    updateTestParameter.next(checkCompleted);

    // AWS Batch job submission task for topic deletion
    const deleteTopics = new tasks.BatchSubmitJob(this, 'DeleteAllTopics', {
      jobName: 'DeleteAllTopics',
      jobDefinitionArn: props.jobDefinition?.ref ?? defaultJobDefinition.ref,
      jobQueueArn: props.jobQueue?.attrJobQueueArn ?? jobQueue.attrJobQueueArn,
      containerOverrides: {
          command: [...(props.commandParameters ?? commandParameters), '--command', 'delete-topics' ]
      },
      payload: props.payload ?? payload,
      resultPath: sfn.JsonPath.DISCARD
    });

    // State machine transition definition
    deleteTopics.next(updateTestParameter);
    queryProducerResult.next(deleteTopics);

    // Step Functions Fail state
    const fail = new sfn.Fail(this, 'Fail');

    // AWS Batch job submission task for cleanup operations
    const cleanup = new tasks.BatchSubmitJob(this, 'DeleteAllTopicsTrap', {
      jobName: 'DeleteAllTopics',
      jobDefinitionArn: props.jobDefinition?.ref ?? defaultJobDefinition.ref,
      jobQueueArn: props.jobQueue?.attrJobQueueArn ?? jobQueue.attrJobQueueArn,
      containerOverrides: {
          command: [...(props.commandParameters ?? commandParameters), '--command', 'delete-topics' ]
      },
      payload: props.payload,
      resultPath: sfn.JsonPath.DISCARD
    });

    // State machine transition definition 
    cleanup.next(fail);

    // Step Functions parallel state configuration
    const parallel = new sfn.Parallel(this, 'IterateThroughPerformanceTests');

    parallel.branch(updateTestParameter);
    parallel.addCatch(cleanup);

    // Step Functions state machine definition
    const stateMachine = new sfn.StateMachine(this, 'StateMachine', {
      definitionBody: sfn.DefinitionBody.fromChainable(parallel),
      stateMachineName: `${Aws.STACK_NAME}-State-Machine-main`
    });

    // AWS Custom Resource configuration for automatically initiating performance tests when the stack is created, if initial test parameters are provided
    if (props.initialPerformanceTest) {
      new AwsCustomResource(this, 'InitialPerformanceTestResource', {
        policy: AwsCustomResourcePolicy.fromSdkCalls({
          resources: [stateMachine.stateMachineArn]
        }),
        onCreate: {
          action: "startExecution",
          service: "StepFunctions",
          parameters: {
            input: JSON.stringify(props.initialPerformanceTest),
            stateMachineArn: stateMachine.stateMachineArn
          },
          physicalResourceId: {
            id: 'InitialPerformanceTestCall'
          }
        }
      })
    }

    // CloudWatch graph widget configuration for Kafka throughput monitoring
    const bytesInWidget = new cloudwatch.GraphWidget({
      left: [
        new cloudwatch.MathExpression({
          expression: `SUM(SEARCH('{AWS/Kafka,"Broker ID","Cluster Name"} "Cluster Name"="${kafka.clusterName}" MetricName="BytesInPerSec"', 'Minimum', 60))/1024/1024`,
          label: `cluster ${kafka.clusterName}`,
          usingMetrics: {}
        }),
        new cloudwatch.MathExpression({
          expression: `SEARCH('{AWS/Kafka,"Broker ID","Cluster Name"} "Cluster Name"="${kafka.clusterName}" MetricName="BytesInPerSec"', 'Minimum', 60)/1024/1024`,
          label: 'broker',
          usingMetrics: {}
        }),
      ],
      leftYAxis: {
        min: 0
      },
      title: 'throughput in (MB/sec)',
      width: 24,
      liveData: true
    });

    // CloudWatch graph widget configuration for Kafka broker throughput standard deviation monitoring
    const bytesInOutStddevWidget = new cloudwatch.GraphWidget({
      left: [
        new cloudwatch.MathExpression({
          expression: `STDDEV(SEARCH('{AWS/Kafka,"Broker ID","Cluster Name"} "Cluster Name"="${kafka.clusterName}" MetricName="BytesInPerSec"', 'Minimum', 60))/1024/1024`,
          label: 'in',
          usingMetrics: {}
        }),
        new cloudwatch.MathExpression({
          expression: `STDDEV(SEARCH('{AWS/Kafka,"Broker ID","Cluster Name"} "Cluster Name"="${kafka.clusterName}" MetricName="BytesOutPerSec"', 'Minimum', 60))/1024/1024`,
          label: 'out',
          usingMetrics: {}
        }),
      ],
      leftYAxis: {
        min: 0,
        max: 3
      },
      leftAnnotations: [{
        value: 0.75
      }],
      title: 'stdev broker throughput (MB/sec)',
      width: 24,
      liveData: true,
    });

    // CloudWatch graph widget configuration for Kafka outbound throughput monitoring
    const bytesOutWidget = new cloudwatch.GraphWidget({
      left: [
        new cloudwatch.MathExpression({
          expression: `SUM(SEARCH('{AWS/Kafka,"Broker ID","Cluster Name"} "Cluster Name"="${kafka.clusterName}" MetricName="BytesOutPerSec"', 'Average', 60))/1024/1024`,
          label: `cluster ${kafka.clusterName}`,
          usingMetrics: {}
        }),
        new cloudwatch.MathExpression({
          expression: `SEARCH('{AWS/Kafka,"Broker ID","Cluster Name"} "Cluster Name"="${kafka.clusterName}" MetricName="BytesOutPerSec"', 'Average', 60)/1024/1024`,
          label: 'broker',
          usingMetrics: {}
        }),
      ],
      title: 'throughput out (MB/sec)',
      width: 24,
      liveData: true
    });

    // CloudWatch graph widget configuration for monitoring burst credits and balances
    const burstBalance = new cloudwatch.GraphWidget({
      left: [
        new cloudwatch.MathExpression({
          expression: `SEARCH('{AWS/Kafka,"Broker ID","Cluster Name"} "Cluster Name"="${kafka.clusterName}" MetricName="BurstBalance"', 'Minimum', 60)`,
          label: `EBS volume BurstBalance`,
          usingMetrics: {}
        }),
        new cloudwatch.MathExpression({
          expression: `SEARCH('{AWS/Kafka,"Broker ID","Cluster Name"} "Cluster Name"="${kafka.clusterName}" MetricName="CPUCreditBalance"', 'Minimum', 60)`,
          label: `CPUCreditBalance`,
          usingMetrics: {}
        }),
      ],
      title: 'burst balances',
      width: 24,
      liveData: true
    });

    // CloudWatch graph widget configuration for monitoring network traffic shaping and throttling
    const trafficShaping = new cloudwatch.GraphWidget({
      left: [
        new cloudwatch.MathExpression({
          expression: `SEARCH('{AWS/Kafka,"Broker ID","Cluster Name"} "Cluster Name"="${kafka.clusterName}" MetricName="BwInAllowanceExceeded"', 'Maximum', 60)`,
          label: `BwInAllowanceExceeded`,
          usingMetrics: {}
        }),
        new cloudwatch.MathExpression({
          expression: `SEARCH('{AWS/Kafka,"Broker ID","Cluster Name"} "Cluster Name"="${kafka.clusterName}" MetricName="BwOutAllowanceExceeded"', 'Maximum', 60)`,
          label: `BwOutAllowanceExceeded`,
          usingMetrics: {}
        }),
        new cloudwatch.MathExpression({
          expression: `SEARCH('{AWS/Kafka,"Broker ID","Cluster Name"} "Cluster Name"="${kafka.clusterName}" MetricName="PpsAllowanceExceeded"', 'Maximum', 60)`,
          label: `PpsAllowanceExceeded`,
          usingMetrics: {}
        }),
        new cloudwatch.MathExpression({
          expression: `SEARCH('{AWS/Kafka,"Broker ID","Cluster Name"} "Cluster Name"="${kafka.clusterName}" MetricName="ConntrackAllowanceExceeded"', 'Maximum', 60)`,
          label: `ConntrackAllowanceExceeded`,
          usingMetrics: {}
        }),
      ],
      title: 'traffic shaping applied',
      width: 24,
      liveData: true
    });

    // CloudWatch graph widget configuration for monitoring CPU idle time in Kafka brokers
    const cpuIdleWidget = new cloudwatch.GraphWidget({
      left: [
        new cloudwatch.MathExpression({
          expression: `AVG(SEARCH('{AWS/Kafka,"Broker ID","Cluster Name"} "Cluster Name"="${kafka.clusterName}" MetricName="CpuIdle"', 'Minimum', 60))`,
          label: `cluster ${kafka.clusterName}`,
          usingMetrics: {}
        }),
        new cloudwatch.MathExpression({
          expression: `SEARCH('{AWS/Kafka,"Broker ID","Cluster Name"} "Cluster Name"="${kafka.clusterName}" MetricName="CpuIdle"', 'Minimum', 60)`,
          label: 'broker',
          usingMetrics: {}
        }),
      ],
      title: 'cpu idle (percent)',
      width: 24,
      leftYAxis: {
        min: 0
      },
      liveData: true
    });

    // CloudWatch graph widget configuration for monitoring Kafka partition replication health
    const replicationWidget = new cloudwatch.GraphWidget({
      left: [
        new cloudwatch.MathExpression({
          expression: `SUM(SEARCH('{AWS/Kafka,"Broker ID","Cluster Name"} "Cluster Name"="${kafka.clusterName}" MetricName="UnderReplicatedPartitions"', 'Maximum', 60))`,
          label: 'under replicated',
          usingMetrics: {}
        }),
        new cloudwatch.MathExpression({
          expression: `SUM(SEARCH('{AWS/Kafka,"Broker ID","Cluster Name"} "Cluster Name"="${kafka.clusterName}" MetricName="UnderMinIsrPartitionCount"', 'Maximum', 60))`,
          label: 'under min isr',
          usingMetrics: {}
        }),
      ],
      leftYAxis: {
        min: 0
      },
      title: 'partition (count)',
      width: 24,
      liveData: true
    });

    // CloudWatch graph widget configuration for monitoring Kafka partition counts
    const partitionWidget = new cloudwatch.GraphWidget({
      left: [
        new cloudwatch.MathExpression({
          expression: `SUM(SEARCH('{AWS/Kafka,"Broker ID","Cluster Name"} "Cluster Name"="${kafka.clusterName}" MetricName="PartitionCount"', 'Maximum', 60))`,
          label: 'partiton count',
          usingMetrics: {}
        }),
        new cloudwatch.MathExpression({
          expression: `SEARCH('{AWS/Kafka,"Broker ID","Cluster Name"} "Cluster Name"="${kafka.clusterName}" MetricName="PartitionCount"', 'Maximum', 60)`,
          label: 'partiton count',
          usingMetrics: {}
        }),        
      ],
      leftYAxis: {
        min: 0
      },
      title: 'partition (count)',
      width: 24,
      liveData: true
    });

    // CloudWatch dashboard configuration that organizes all the previously defined Kafka monitoring widgets
    const dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: Aws.STACK_NAME,
      widgets: [
        [ bytesInWidget ],
        [ bytesOutWidget ],
        [ trafficShaping ],
        [ burstBalance ],
        [ bytesInOutStddevWidget ],
        [ cpuIdleWidget ],
        [ replicationWidget ],
        [ partitionWidget ]
      ],
    });

    // IAM role configuration for SageMaker instance
    const sagemakerInstanceRole = new iam.Role(this, 'SagemakerInstanceRole', {
      // Role trust relationship
      assumedBy: new iam.ServicePrincipal('sagemaker.amazonaws.com'),
      inlinePolicies: {
        // CloudFormation policy
        cloudFormation: new iam.PolicyDocument({
          statements: [new iam.PolicyStatement({
            actions: [
              'cloudformation:DescribeStacks',
              'cloudformation:ListStacks',
              'cloudformation:GetTemplate'
            ],
            resources: [ 
              `arn:${Aws.PARTITION}:cloudformation:${Aws.REGION}:${Aws.ACCOUNT_ID}:stack/*`,  
            ],
          })]
        }),
        // CloudWatch Logs policy 
        cwLogs: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                'logs:StartQuery',
                'logs:GetQueryResults',
                'logs:StopQuery',
                'logs:DescribeLogGroups',
                'logs:DescribeLogStreams',
                'logs:GetLogEvents',
                'logs:FilterLogEvents'
              ],
              resources: [
                `arn:${Aws.PARTITION}:logs:${Aws.REGION}:${Aws.ACCOUNT_ID}:log-group:*:*`,
                `arn:${Aws.PARTITION}:logs:${Aws.REGION}:${Aws.ACCOUNT_ID}:log-group:*`
              ]
            }),
            new iam.PolicyStatement({
              actions: [
                'logs:DescribeLogGroups'
              ],
              resources: [
                `arn:${Aws.PARTITION}:logs:${Aws.REGION}:${Aws.ACCOUNT_ID}:log-group:*`
              ]
            })
          ]
        }),
        // Step Functions policy
        stepFunctions: new iam.PolicyDocument({
          statements: [new iam.PolicyStatement({
            actions: [
              'states:DescribeExecution',
              'states:ListExecutions'
            ],
            resources: [ 
              `arn:${Aws.PARTITION}:states:${Aws.REGION}:${Aws.ACCOUNT_ID}:execution:*:*`,
              `arn:${Aws.PARTITION}:states:${Aws.REGION}:${Aws.ACCOUNT_ID}:stateMachine:*`
            ],
          })]
        })
      }
    });

    // Sagemaker notebook instance configuration
    const sagemakerNotebook = new sagemaker.CfnNotebookInstance(this, 'SagemakerNotebookInstance', {
      instanceType: 'ml.t3.medium',
      roleArn: sagemakerInstanceRole.roleArn,
      notebookInstanceName: Aws.STACK_NAME,
      defaultCodeRepository: 'https://github.com/aws-samples/performance-testing-framework-for-apache-kafka/',
      platformIdentifier: 'notebook-al2-v3'
    });

    // CloudFormation output configuration for the SageMaker notebook URL
    new CfnOutput(this, 'SagemakerNotebook', { 
      value: `https://console.aws.amazon.com/sagemaker/home#/notebook-instances/openNotebook/${sagemakerNotebook.attrNotebookInstanceName}?view=lab`
    });

    // CloudFormation output configuration for the CloudWatch Log Group
    new CfnOutput(this, 'LogGroupName', { 
      value: performanceTestLogGroup.logGroupName 
    });
  }
}
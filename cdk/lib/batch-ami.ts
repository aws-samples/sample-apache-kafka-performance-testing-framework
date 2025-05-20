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
import { Aws, Stack, StackProps } from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as imagebuilder from 'aws-cdk-lib/aws-imagebuilder';

// Class declaration
export class BatchAmiStack extends Stack {
  public readonly ami: ec2.IMachineImage;

  // Constructor definition
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Image builder component creation
    const agentComponent = new imagebuilder.CfnComponent(this, 'ImageBuilderComponent', {
      name: `${Aws.STACK_NAME}`,
      platform: 'Linux',
      version: '1.0.0',
      // Component configuration steps
      data: `
        name: AWS Batch Custom Image
        description: Optimized image for AWS Batch with CloudWatch integration
        schemaVersion: 1.0
        phases:
          - name: build
            steps:
              - name: InstallCloudWatchAgentStep
                action: ExecuteBash
                inputs:
                  commands:
                    - |
                      cat <<'EOF' >> /etc/ecs/ecs.config
                      ECS_ENABLE_CONTAINER_METADATA=true
                      EOF
                    # Install CloudWatch agent using dnf (AL2023 package manager)
                    - dnf install -y amazon-cloudwatch-agent
                    - |
                      cat > /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json << 'EOF'
                      {
                        "agent":{
                            "metrics_collection_interval":10,
                            "omit_hostname":true
                        },
                        "logs":{
                            "logs_collected":{
                              "files":{
                                  "collect_list":[
                                    {
                                        "file_path":"/var/log/ecs/ecs-agent.log*",
                                        "log_group_name":"/aws-batch/ecs-agent.log",
                                        "log_stream_name":"{instance_id}",
                                        "timezone":"Local"
                                    },
                                    {
                                        "file_path":"/var/log/ecs/ecs-init.log",
                                        "log_group_name":"/aws-batch/ecs-init.log",
                                        "log_stream_name":"{instance_id}",
                                        "timezone":"Local"
                                    },
                                    {
                                        "file_path":"/var/log/ecs/audit.log*",
                                        "log_group_name":"/aws-batch/audit.log",
                                        "log_stream_name":"{instance_id}",
                                        "timezone":"Local"
                                    },
                                    {
                                        "file_path":"/var/log/messages",
                                        "log_group_name":"/aws-batch/messages",
                                        "log_stream_name":"{instance_id}",
                                        "timezone":"Local"
                                    }
                                  ]
                              }
                            }
                        }
                      }
                      EOF
                    - systemctl enable amazon-cloudwatch-agent
                    - systemctl start amazon-cloudwatch-agent`
    });

    // Create image recipe with AL2023 ECS-Optimized AMI
    const imageReceipe = new imagebuilder.CfnImageRecipe(this, 'ImageBuilderReceipt', {
      components: [{
        componentArn: agentComponent.attrArn
      }],
      name: Aws.STACK_NAME,
      parentImage: ecs.EcsOptimizedImage.amazonLinux2023().getImage(this).imageId,
      version: '1.0.0'
      blockDeviceMappings: [{
        deviceName: '/dev/xvda',
        ebs: {
          volumeSize: 30,
          volumeType: 'gp3',
          deleteOnTermination: true,
          encrypted: true
        }
      }]
    });

    // Create IAM role with required permissions
    const imageBuilderRole = new iam.Role(this, 'ImageBuilderRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('EC2InstanceProfileForImageBuilder')
      ]
    });

    // Add specific permissions for CloudWatch
    imageBuilderRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ssm:GetParameter',
        'cloudwatch:PutMetricData'
      ],
      resources: ['*']
    }));

    // Create instance profile
    const imageBuilderProfile = new iam.CfnInstanceProfile(this, 'ImageBuilderInstanceProfile', {
      roles: [ imageBuilderRole.roleName ],
    });

    // Create infrastructure configuration
    const infrastructureconfiguration = new imagebuilder.CfnInfrastructureConfiguration(this, 'InfrastructureConfiguration', {
      name: Aws.STACK_NAME,
      instanceProfileName: imageBuilderProfile.ref
    });

    // Create image
    const image = new imagebuilder.CfnImage(this, 'Image', {
      imageRecipeArn: imageReceipe.attrArn,
      infrastructureConfigurationArn: infrastructureconfiguration.attrArn,
    });

    // Set the AMI
    this.ami = ec2.MachineImage.genericLinux({
      [ this.region ] : image.attrImageId
    });
  }
}
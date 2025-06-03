#!/usr/bin/env node

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

// AWS CDK services (using consistent naming)
import { App, Environment } from 'aws-cdk-lib';
import { CdkStack } from '../lib/cdk-stack';
import { VpcStack } from '../lib/vpc';
import { InstanceClass, InstanceSize, InstanceType } from 'aws-cdk-lib/aws-ec2';
import { ClientBrokerEncryption, KafkaVersion } from '@aws-cdk/aws-msk-alpha';

const app = new App();

// Environment configuration - update with your AWS account and region
const defaults: { 'env': Environment } = {
  env: {
    account: '123456789012',  // Replace with your AWS account ID
    region: 'us-east-1'       // Replace with your target region
  }
};

// Create VPC for MSK clusters
const vpc = new VpcStack(app, 'MSK-Perf-Test-VPC', defaults).vpc;

// M7g.Large cluster configuration
// You can change the InstanceType parameters, the Apache Kafka version, and the CDK stack name, to reflect your requirements:
new CdkStack(app, 'MSK-Perf-Test-M7g-Large', {
  ...defaults,
  vpc: vpc,
  clusterProps: {
    numberOfBrokerNodes: 1,
    instanceType: InstanceType.of(InstanceClass.M7G, InstanceSize.LARGE),
    ebsStorageInfo: {
      volumeSize: 6000
    },
    encryptionInTransit: {
      enableInCluster: false,
      clientBroker: ClientBrokerEncryption.PLAINTEXT
    },
    kafkaVersion: KafkaVersion.V3_6_0,
  },
});

// M7g.XLarge cluster configuration
// You can change the InstanceType parameters, the kafka version, and the CDK stack name, to reflect your requirements:
new CdkStack(app, 'MSK-Perf-Test-M7g-XLarge', {
  ...defaults,
  vpc: vpc,
  clusterProps: {
    numberOfBrokerNodes: 1,
    instanceType: InstanceType.of(InstanceClass.M7G, InstanceSize.XLARGE),
    ebsStorageInfo: {
      volumeSize: 6000
    },
    encryptionInTransit: {
      enableInCluster: false,
      clientBroker: ClientBrokerEncryption.PLAINTEXT
    },
    kafkaVersion: KafkaVersion.V3_6_0
  },
});

// M7g.2XLarge cluster configuration
// You can change the InstanceType parameters, the kafka version, and the CDK stack name, to reflect your requirements:
new CdkStack(app, 'MSK-Perf-Test-M7g-2XLarge', {
  ...defaults,
  vpc: vpc,
  clusterProps: {
    numberOfBrokerNodes: 1,
    instanceType: InstanceType.of(InstanceClass.M7G, InstanceSize.XLARGE2),
    ebsStorageInfo: {
      volumeSize: 6000
    },
    encryptionInTransit: {
      enableInCluster: false,
      clientBroker: ClientBrokerEncryption.PLAINTEXT
    },
    kafkaVersion: KafkaVersion.V3_6_0
  },
});

// M7g.2XLarge cluster configuration with maximum provisioned storage throughput enabled
// You can change the InstanceType parameters, the kafka version, and the CDK stack name, to reflect your requirements:
new CdkStack(app, 'MSK-Perf-Test-M7g-2XLarge-PST', {
  ...defaults,
  vpc: vpc,
  clusterProps: {
    numberOfBrokerNodes: 1,
    instanceType: InstanceType.of(InstanceClass.M7G, InstanceSize.XLARGE2),
    ebsStorageInfo: {
      volumeSize: 6000,
      provisionedThroughput: {
        enabled: true,
        volumeThroughput: 312
      }
    },
    encryptionInTransit: {
      enableInCluster: false,
      clientBroker: ClientBrokerEncryption.PLAINTEXT
    },
    kafkaVersion: KafkaVersion.V3_6_0,
  }
});

// M7g.4XLarge cluster configuration
// You can change the InstanceType parameters, the kafka version, and the CDK stack name, to reflect your requirements:
new CdkStack(app, 'MSK-Perf-Test-M7g-4XLarge', {
  ...defaults,
  vpc: vpc,
  clusterProps: {
    numberOfBrokerNodes: 1,
    instanceType: InstanceType.of(InstanceClass.M7G, InstanceSize.XLARGE4),
    ebsStorageInfo: {
      volumeSize: 6000
    },
    encryptionInTransit: {
      enableInCluster: false,
      clientBroker: ClientBrokerEncryption.PLAINTEXT
    },
    kafkaVersion: KafkaVersion.V3_6_0
  },
});

// M7g.4XLarge cluster configuration with maximum provisioned storage throughput enabled
// You can change the InstanceType parameters, the kafka version, and the CDK stack name, to reflect your requirements:
new CdkStack(app, 'MSK-Perf-Test-M7g-4XLarge-PST', {
  ...defaults,
  vpc: vpc,
  clusterProps: {
    numberOfBrokerNodes: 1,
    instanceType: InstanceType.of(InstanceClass.M7G, InstanceSize.XLARGE4),
    ebsStorageInfo: {
      volumeSize: 6000,
      provisionedThroughput: {
        enabled: true,
        volumeThroughput: 625
      }
    },
    encryptionInTransit: {
      enableInCluster: false,
      clientBroker: ClientBrokerEncryption.PLAINTEXT
    },
    kafkaVersion: KafkaVersion.V3_6_0,
  }
});

// M7g.8XLarge cluster configuration with maximum provisioned storage throughput enabled
// You can change the InstanceType parameters, the kafka version, and the CDK stack name, to reflect your requirements:
new CdkStack(app, 'MSK-Perf-Test-M7g-8XLarge-PST', {
  ...defaults,
  vpc: vpc,
  clusterProps: {
    numberOfBrokerNodes: 1,
    instanceType: InstanceType.of(InstanceClass.M7G, InstanceSize.XLARGE8),
    ebsStorageInfo: {
      volumeSize: 6000,
      provisionedThroughput: {
        enabled: true,
        volumeThroughput: 1000
      }
    },
    encryptionInTransit: {
      enableInCluster: false,
      clientBroker: ClientBrokerEncryption.PLAINTEXT
    },
    kafkaVersion: KafkaVersion.V3_6_0,
  }
});
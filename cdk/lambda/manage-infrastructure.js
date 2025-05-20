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

// SDK imports
const { 
  BatchClient, 
  TerminateJobCommand, 
  DescribeJobsCommand,
  UpdateComputeEnvironmentCommand 
} = require('@aws-sdk/client-batch');
const { CloudWatchClient, GetMetricDataCommand } = require('@aws-sdk/client-cloudwatch');

// Client initialization
const batchClient = new BatchClient();
const cloudWatchClient = new CloudWatchClient();

// Function definition
exports.queryMskClusterThroughput = async function(event) {
  console.log(JSON.stringify(event));
  
  // Job description command
  const describeJobsCommand = new DescribeJobsCommand({
      jobs: [
          event.depletion_job.JobId
      ]
  });

  // Job details retreival  
  const jobDetails = await batchClient.send(describeJobsCommand);
  console.log(JSON.stringify(jobDetails));

  const jobCreatedAt = jobDetails.jobs[0].createdAt;
  const statusSummary = jobDetails.jobs[0].arrayProperties.statusSummary;

  // Query max cluster throughput in the last 5 min, but not before the job started
  const queryEndTime = Date.now();
  const queryStartTime = Math.max(queryEndTime - 300_000, jobCreatedAt);

  // CloudWatch metric query setup
  const getMetricDataCommand = new GetMetricDataCommand({
      EndTime: new Date(queryEndTime),
      StartTime: new Date(queryStartTime),
      MetricDataQueries: [
          {
              Id: 'bytesInSum',
              Expression: `SUM(SEARCH('{AWS/Kafka,"Broker ID","Cluster Name"} "Cluster Name"="${process.env.MSK_CLUSTER_NAME}" MetricName="BytesInPerSec"', 'Maximum', 300))`,
              Period: '300',
          },
          {
              Id: 'bytesInStddev',
              Expression: `STDDEV(SEARCH('{AWS/Kafka,"Broker ID","Cluster Name"} "Cluster Name"="${process.env.MSK_CLUSTER_NAME}" MetricName="BytesInPerSec"', 'Minimum', 60))`,
              Period: '60',
          }
      ],
  });

  // Metric data retreival
  const metrics = await cloudWatchClient.send(getMetricDataCommand);
  console.log(JSON.stringify(metrics));

  // Results processing
  const result = {
      clusterMbInPerSec: metrics.MetricDataResults.find(m => m.Id == 'bytesInSum').Values[0] / 1024**2,
      brokerMbInPerSecStddev: metrics.MetricDataResults.find(m => m.Id == 'bytesInStddev').Values.reduce((acc,v) => v>acc ? v : acc, 0) / 1024**2,
      succeededPlusFailedJobs: statusSummary.SUCCEEDED + statusSummary.FAILED
  };

  console.log(JSON.stringify(result));
  return result;
};

// Function handling the termination of the AWS Batch depletion job
exports.terminateDepletionJob = async (event) => {
  console.log('Event:', JSON.stringify(event, null, 2));

  // Terminate command creation
  const terminateCommand = new TerminateJobCommand({
      jobId: event.JobId,
      reason: "Batch job terminated by StepFunctions workflow."
  });

  // Error handling and execution
  try {
      const response = await batchClient.send(terminateCommand);
      return response;
  } catch (error) {
      console.error('Error:', error);
      throw error;
  }
};

// Function handling the AWS Batch compute environment's minimum vCPU allocation
exports.updateMinCpus = async function(event) {
  console.log(JSON.stringify(event));

  // Update command creation
  const updateCommand = new UpdateComputeEnvironmentCommand({
      computeEnvironment: process.env.COMPUTE_ENVIRONMENT,
      computeResources: {
          minvCpus: 'current_test' in event ? event.current_test.parameters.num_jobs * 2 : 0
      }
  });

  // Command execution and error handling
  try {
      return await batchClient.send(updateCommand);
  } catch (error) {
      console.error('Error:', error);
      throw error;
  }
};
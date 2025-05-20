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
const { BatchClient, DescribeJobsCommand } = require('@aws-sdk/client-batch');
const { CloudWatchLogsClient, GetLogEventsCommand } = require('@aws-sdk/client-cloudwatch-logs');

// Client initialization
const batchClient = new BatchClient();
const cloudwatchLogsClient = new CloudWatchLogsClient();

// Performance metrics parsing
async function parsePerformanceMetrics(logEvents) {
    let finalMetrics = null;

    for (const event of logEvents) {
        const message = event.message;
        
        // Match the performance metrics line
        const metricsMatch = message.match(/(\d+) records sent, ([\d.]+) records\/sec \(([\d.]+) MB\/sec\), ([\d.]+) ms avg latency, ([\d.]+) ms max latency/);
        
        if (metricsMatch) {
            finalMetrics = {
                type: 'producer',
                test_summary: {
                    records_sent: parseInt(metricsMatch[1]),
                    records_per_sec: parseFloat(metricsMatch[2]),
                    mb_per_sec: parseFloat(metricsMatch[3]),
                    avg_latency_ms: parseFloat(metricsMatch[4]),
                    max_latency_ms: parseFloat(metricsMatch[5])
                },
                error_count: 0
            };
        }
    }

    return finalMetrics;
}

// Function to query the CloudWatch log streams, extract and process the kafka performance metrics
async function queryAndParseLogs(params, expectedResults) {
    console.log('Starting log query process...');
    const allResults = [];

    // Get all logs from each stream
    for (const streamName of params.logStreamNames) {
        try {
            const getLogsCommand = new GetLogEventsCommand({
                logGroupName: params.logGroupName,
                logStreamName: streamName,
                limit: 1000  // Get enough logs to find the metrics
            });
            
            const logEvents = await cloudwatchLogsClient.send(getLogsCommand);
            console.log(`\nStream ${streamName} has ${logEvents.events.length} events`);
            
            // Metric extraction and validation
            if (logEvents.events.length > 0) {
                const metrics = await parsePerformanceMetrics(logEvents.events);
                if (metrics) {
                    allResults.push(metrics);
                    console.log(`Found metrics in stream ${streamName}:`, JSON.stringify(metrics, null, 2));
                } else {
                    console.log(`No performance metrics found in stream ${streamName}`);
                    // Log some sample messages for debugging
                    console.log('Sample messages from stream:');
                    logEvents.events.slice(0, 5).forEach((event, i) => {
                        console.log(`Message ${i + 1}:`, event.message);
                    });
                }
            } else {
                console.log('No logs found in stream');
            }
        //Error handling and results validation
        } catch (error) {
            console.error(`Error getting logs from stream ${streamName}:`, error);
        }
    }

    console.log(`Found ${allResults.length} results out of ${expectedResults} expected`);
    
    if (allResults.length === expectedResults) {
        return allResults;
    }

    throw new Error(`incomplete query results: expected ${expectedResults} results, found ${allResults.length}`);
}

// Main Lambda handler function queryProducerOutput which processes Kafka producer test results
exports.queryProducerOutput = async function(event) {
    console.log('Received event:', JSON.stringify(event, null, 2));

    // Validate event structure
    if (!event?.current_test?.parameters?.num_producers) {
        throw new Error(`Missing num_producers parameter. Event: ${JSON.stringify(event)}`);
    }

    if (!event?.job_result?.JobId) {
        throw new Error(`Missing JobId in job_result. Event: ${JSON.stringify(event)}`);
    }

    const numProducer = event.current_test.parameters.num_producers;
    const parentJobId = event.job_result.JobId;

    console.log(`Processing request for numProducer: ${numProducer}, parentJobId: ${parentJobId}`);

    try {
        // Job description parameter setup
        const describeParams = {
            jobs: [...Array(numProducer).keys()].map(index => `${parentJobId}:${index}`)
        };

        console.log('Describing jobs with params:', JSON.stringify(describeParams, null, 2));
        
        const command = new DescribeJobsCommand(describeParams);
        const jobDescriptions = await batchClient.send(command);
        
        if (!jobDescriptions.jobs || jobDescriptions.jobs.length === 0) {
            throw new Error(`No job descriptions found for parent job: ${parentJobId}`);
        }

        console.log('Retrieved job descriptions:', JSON.stringify(jobDescriptions, null, 2));

        // Log stream extraction
        const logStreams = jobDescriptions.jobs.map(job => {
            if (!job.attempts?.[0]?.container?.logStreamName) {
                throw new Error(`Missing log stream name for job: ${JSON.stringify(job)}`);
            }
            return job.attempts[0].container.logStreamName;
        });

        console.log('Found log streams:', JSON.stringify(logStreams, null, 2));

        // Log query setup and extraction
        if (!process.env.LOG_GROUP_NAME) {
            throw new Error('LOG_GROUP_NAME environment variable is not set');
        }

        const queryParams = {
            logGroupName: process.env.LOG_GROUP_NAME,
            logStreamNames: logStreams
        };

        return await queryAndParseLogs(queryParams, numProducer);
    
    // Error handling
    } catch (error) {
        console.error('Error in queryProducerOutput:', error);
        console.error('Parameters:', { 
            numProducer, 
            parentJobId,
            eventStructure: {
                hasCurrentTest: !!event.current_test,
                hasParameters: !!event.current_test?.parameters,
                hasNumProducers: !!event.current_test?.parameters?.num_producers,
                hasJobResult: !!event.job_result,
                hasJobId: !!event.job_result?.JobId
            }
        });
        throw error;
    }
}
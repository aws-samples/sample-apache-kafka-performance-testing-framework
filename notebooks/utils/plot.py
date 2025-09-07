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
import matplotlib.pyplot as plt
import matplotlib.colors as mcolors
from matplotlib.ticker import AutoMinorLocator
import math

# Calculate dynamic axis limits based on data
def get_axis_limits(data, metric_line_style_names):
    x_values = []
    y_values = []
    
    # Collect all x and y values
    for d in data:
        x_values.append(float(d['test_params']['target_throughput']))
        for metric in metric_line_style_names:
            if metric in d['test_results']:
                y_values.append(float(d['test_results'][metric]))
    
    # Calculate ranges with 10% padding
    x_min, x_max = min(x_values), max(x_values)
    y_min, y_max = min(y_values), max(y_values)
    
    x_padding = (x_max - x_min) * 0.1
    y_padding = (y_max - y_min) * 0.1
    
    return {
        'x_min': max(0, x_min - x_padding),
        'x_max': x_max + x_padding,
        'y_min': max(0, y_min - y_padding),
        'y_max': y_max + y_padding
    }

# Generate tick marks for plot axes
def get_nice_ticks(min_val, max_val, target_steps=10):
    """Generate nice round numbers for tick marks"""
    range_val = max_val - min_val
    step_size = range_val / target_steps
    magnitude = 10 ** math.floor(math.log10(step_size))
    nice_step = magnitude * round(step_size / magnitude)
    start = math.floor(min_val / nice_step) * nice_step
    end = math.ceil(max_val / nice_step) * nice_step
    return np.arange(start, end + nice_step, nice_step)

# Main function for creating performance measurement plots
def plot_measurements(data, metric_line_style_names, ylabel, 
                     xlogscale=False, ylogscale=False, 
                     ymin=None, ymax=None, xmin=None, xmax=None, 
                     exclude=None, indicate_max=False,
                     ignore_keys=None, title_keys=None, row_keys=None, 
                     column_keys=None, metric_color_keys=None):
    
    # Input validation
    if not data:
        print("No data to plot")
        return

    # Debug print to check data structure
    print(f"Data points: {len(data)}")
    print(f"Metrics to plot: {metric_line_style_names}")

    # Initialize colors and markers
    colors = list(mcolors.TABLEAU_COLORS.values())
    markers = ['o', 's', '^', 'D']
    linestyles = ['-', '--', ':', '-.']

    # Create subplot grid with 16:9 aspect ratio
    width = 16
    height = 9
    
    fig, ax = plt.subplots(1, 1, figsize=(width, height), squeeze=False)
    subplot = ax[0][0]

    # Group by test series (using execution_arn or another unique identifier)
    test_groups = {}
    for d in data:
        test_id = d['test_params'].get('execution_arn', 'default') 
        if test_id not in test_groups:
            test_groups[test_id] = []
        test_groups[test_id].append(d)

    # Plot each test series
    for test_idx, (test_id, test_data) in enumerate(test_groups.items()):
        # Group by metric color keys within each test series
        color_groups = {}
        if metric_color_keys:
            for d in test_data:
                color_key = tuple(str(d['test_params'].get(k, 'n/a')) 
                                for k in metric_color_keys)
                if color_key not in color_groups:
                    color_groups[color_key] = []
                color_groups[color_key].append(d)
        else:
            color_groups[(f'Test {test_idx + 1}',)] = test_data

        # Plot each color group within the test series
        for color_idx, (color_key, group_data) in enumerate(color_groups.items()):
            for metric_idx, metric in enumerate(metric_line_style_names):
                # Sort by throughput
                sorted_data = sorted(group_data, 
                                  key=lambda x: float(x['test_params']['target_throughput']))
                
                x_values = [float(d['test_params']['target_throughput']) 
                          for d in sorted_data]
                y_values = [float(d['test_results'][metric]) 
                          for d in sorted_data if metric in d['test_results']]

                if not y_values:
                    print(f"Warning: No data found for metric {metric}")
                    continue

                # Create label with proper structure
                broker_type = sorted_data[0]['test_params'].get('broker_type', 'N/A')
                num_brokers = sorted_data[0]['test_params'].get('num_brokers', 'N/A')

                cg = sorted_data[0]['test_params'].get('consumer_groups.num_groups')
                
                # Remove 'kafka.' prefix and use it to determine test number
                simplified_broker_type = broker_type.replace('kafka.', '')
                
                # Set line style based on metric type
                line_style = '--' if 'p99' in metric else '-'  # dashed for p99, solid for p50
                
                # Generate dynamic plot labels based on grouping criteria
                label_metric = ''

                # Special case: broker_type only grouping uses detailed format
                if len(metric_color_keys) == 1 and metric_color_keys[0] == 'broker_type':
                    label = f"Test {color_idx + 1} - brokers: {num_brokers} - broker_type: {simplified_broker_type} - {metric}"
                else:
                    # Multi-criteria grouping: build composite label with all metric keys
                    for metric_color in metric_color_keys:
                        if metric_color != '':
                            label_metric = label_metric + f" - {metric_color}: {sorted_data[0]['test_params'].get(metric_color)}"
                        else:
                            label_metric = f"No defined metric key"
                    # Create plot legend label with test configuration and metric
                    label = f"Test {color_idx + 1} - brokers: {num_brokers} - broker_type: {simplified_broker_type}{label_metric} - {metric}"

                # Plot line with test-specific styling
                subplot.plot(x_values, y_values, 
                           label=label,
                           marker=markers[metric_idx % len(markers)],
                           linestyle=line_style,  # Use the metric-based line style
                           color=colors[color_idx % len(colors)],
                           linewidth=2,
                           markersize=8)

    # Get dynamic axis limits
    limits = get_axis_limits(data, metric_line_style_names)
    
    # Set dynamic ticks
    x_ticks = get_nice_ticks(limits['x_min'], limits['x_max'])
    y_ticks = get_nice_ticks(limits['y_min'], limits['y_max'])
    
    # Configure subplot
    subplot.grid(True, which='both', linestyle='-', alpha=0.2)
    subplot.set_xlabel("requested aggregated producer throughput (mb/sec)", fontsize=12)
    subplot.set_ylabel(ylabel, fontsize=12)

    # Set scales
    subplot.set_xscale('linear')
    subplot.set_yscale('linear')

    # Configure axes with dynamic ranges
    subplot.set_xticks(x_ticks)
    subplot.set_yticks(y_ticks)
    subplot.set_xlim(left=limits['x_min'], right=limits['x_max'])
    subplot.set_ylim(bottom=limits['y_min'], top=limits['y_max'])

    # Rotate x-axis labels for better readability
    subplot.tick_params(axis='x', rotation=45)

    # Increase tick label sizes
    subplot.tick_params(axis='both', labelsize=12)

    # Add minor ticks
    subplot.xaxis.set_minor_locator(AutoMinorLocator())
    subplot.yaxis.set_minor_locator(AutoMinorLocator())

    # Create multi-line title
    if title_keys:
        title_lines = []
        # First line: title parameters
        title_dict = {k: data[0]['test_params'].get(k, 'n/a') for k in title_keys}
        title_lines.append(str(title_dict))
        
        # Second line: column parameters
        if column_keys:
            col_dict = {k: data[0]['test_params'].get(k, 'n/a') for k in column_keys}
            title_lines.append(str(col_dict))
        
        # Third line: row parameters
        if row_keys:
            row_dict = {k: data[0]['test_params'].get(k, 'n/a') for k in row_keys}
            title_lines.append(str(row_dict))
        
        # Add one empty line between title and plot
        title_lines.append("")
        
        fig.suptitle('\n'.join(title_lines), fontsize=12, y=0.95)

    # Customize grid
    subplot.grid(True, which='major', linestyle='-', alpha=0.5)
    subplot.grid(True, which='minor', linestyle=':', alpha=0.2)

    # Place legend at the bottom with proper spacing
    handles, labels = subplot.get_legend_handles_labels()
    fig.legend(handles, labels, 
              loc='outside lower center', 
              bbox_to_anchor=(0.5, -0.01),
              ncol=1,
              fontsize=12)

    # Adjust layout to accommodate legend at bottom
    plt.subplots_adjust(bottom=0.25)  

    # Display the plot
    plt.show()
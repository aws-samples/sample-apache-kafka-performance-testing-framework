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
import sys
import os
import subprocess
import pkg_resources 

# Approved patterns for subprocess commands
def validate_command_against_patterns(cmd):
    """Validates that a command matches one of our approved command patterns."""
    
    # Define allowed command patterns - AWS CLI patterns removed
    APPROVED_COMMAND_PATTERNS = [
        # Python/pip commands
        [sys.executable, "-m", "pip", "install", "--quiet", "PACKAGE"],
        [sys.executable, "-m", "pip", "uninstall", "-y", "--quiet", "PACKAGE"],
        [sys.executable, "-m", "pip", "install", "--quiet", "--no-deps", "PACKAGE"]
    ]
    
    # Check command against each pattern
    for pattern in APPROVED_COMMAND_PATTERNS:
        if len(cmd) != len(pattern):
            continue
            
        # Try to match this pattern
        match = True
        for i, (cmd_part, pattern_part) in enumerate(zip(cmd, pattern)):
            # If pattern part is a placeholder, skip exact matching
            if pattern_part in ["PACKAGE"]:
                continue
            # Otherwise, require exact match
            elif cmd_part != pattern_part:
                match = False
                break
        
        if match:
            return True
            
    # No pattern matched
    raise ValueError(f"Command does not match any approved pattern: {cmd}")

# Define safe subprocess execution
def safe_subprocess_run(cmd, **kwargs):
    """Run subprocess with strict command validation."""
    # Ensure command is valid
    if not validate_command_against_patterns(cmd):
        raise ValueError(f"Command failed validation: {cmd}")
    
    # Force safe parameters
    kwargs['shell'] = False
    kwargs.setdefault('check', True)
    
    # Run the command
    return subprocess.run(cmd, **kwargs)

# List of packages to install
PACKAGES = [
    'boto3',
    'numpy',
    'more-itertools',
    'matplotlib',
    'jupyterlab-git',
    'nbdime',
    'flatten-dict'
]

# Separate dependencies that need specific version handling
DEPENDENCIES = {
    'packaging': 'packaging>=23.0',
    'docutils': 'docutils>=0.20,<0.22',
    'sphinx': 'sphinx>=6.0.0'  
}

# Install a Python package using pip
def pip_install(package_spec):
    try:
        # Use the validated, safe subprocess execution
        safe_subprocess_run(
            [sys.executable, "-m", "pip", "install", "--quiet", package_spec],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE
        )
        print(f"  ✓ Installed {package_spec}")
        return True
    except Exception:
        print(f"  ✗ Error installing {package_spec}")
        return False

# Uninstall a Python package using pip
def pip_uninstall(package_name):
    try:
        safe_subprocess_run(
            [sys.executable, "-m", "pip", "uninstall", "-y", "--quiet", package_name],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE
        )
        return True
    except Exception:
        return False

# Check if a package is installed
def is_package_installed(package_name):
    try:
        pkg_resources.get_distribution(package_name)
        return True
    except pkg_resources.DistributionNotFound:
        return False

# Installs required Python packages
def install_packages():
    try:
        print("📦 Installing Python packages...")
        
        # Upgrade pip first
        pip_install("pip")
        
        # Remove awscli v1 if present (still good to do this)
        if is_package_installed('awscli'):
            pip_uninstall('awscli')
        
        # Handle dependencies with version constraints
        for pkg in DEPENDENCIES:
            if is_package_installed(pkg):
                pip_uninstall(pkg)
        
        for pkg_spec in DEPENDENCIES.values():
            pip_install(pkg_spec)
        
        # Install main packages
        for package in PACKAGES:
            pip_install(package)
        
        return True
    except Exception as e:
        print(f"\n❌ Error installing packages: {str(e)}")
        return False
    
# Verifies the installation of Python packages
def verify_installation():
    try:
        print("\nVerifying installation:")
        
        # Verify Python packages
        for package in ['boto3', 'numpy', 'matplotlib']:
            if is_package_installed(package):
                print(f"✅ {package} successfully installed")
            else:
                print(f"❌ {package} installation verification failed")
    except Exception as e:
        print(f"Error during verification: {str(e)}")
    
# Verifies the installation of Python packages
def verify_installation():
    try:
        print("\nVerifying installation:")
        
        # Verify Python packages
        for package in ['boto3', 'numpy', 'matplotlib']:
            if is_package_installed(package):
                print(f"✅ {package} successfully installed")
            else:
                print(f"❌ {package} installation verification failed")
    except Exception as e:
        print(f"Error during verification: {str(e)}")

# Main installation function
def setup():
    print("🚀 Starting installation process...\n")
    
    if install_packages():
        print("\n✅ Package installation successful")
        verify_installation()
        
        print("\n🎉 Installation complete!")
        print("\n⚠️  IMPORTANT: Please restart your Jupyter kernel to ensure all changes take effect.")
        print("\nNext steps:")
        print("1. Restart the Jupyter kernel")
        print("2. Open '02-create-visualization-template.ipynb'")
        print("3. Follow the instructions to create your visualization templates")
    else:
        print("\n❌ Package installation failed")

if __name__ == "__main__":
    setup()
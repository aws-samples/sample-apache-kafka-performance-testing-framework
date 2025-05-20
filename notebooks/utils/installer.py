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

import sys
import subprocess
import os

# List of packages to install with version constraints
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
    'sphinx': 'sphinx>=6.0.0'  # Updated to match Spyder's requirement
}

def install_packages():
    """
    Installs required Python packages with proper dependency handling.
    """
    try:
        print("📦 Installing Python packages...")
        
        print("  ↳ Upgrading pip...")
        subprocess.check_call([
            sys.executable, 
            '-m', 
            'pip', 
            'install', 
            '--quiet', 
            '--upgrade', 
            'pip'
        ])

        print("  ↳ Removing AWS CLI v1...")
        subprocess.check_call([
            sys.executable,
            '-m',
            'pip',
            'uninstall',
            '-y',
            'awscli'
        ])

        print("  ↳ Handling dependencies...")
        # First uninstall packages that might conflict
        for pkg in DEPENDENCIES.keys():
            try:
                subprocess.check_call([
                    sys.executable,
                    '-m',
                    'pip',
                    'uninstall',
                    '-y',
                    pkg
                ])
            except:
                pass

        # Install dependencies in specific order
        for pkg_spec in DEPENDENCIES.values():
            subprocess.check_call([
                sys.executable,
                '-m',
                'pip',
                'install',
                '--quiet',
                '--no-deps',  # Install without dependencies first
                pkg_spec
            ])

        # Now install with dependencies
        for pkg_spec in DEPENDENCIES.values():
            subprocess.check_call([
                sys.executable,
                '-m',
                'pip',
                'install',
                '--quiet',
                pkg_spec
            ])

        print("  ↳ Installing remaining packages...")
        subprocess.check_call([
            sys.executable, 
            '-m', 
            'pip', 
            'install',
            '--quiet',
            *PACKAGES
        ])
        
        return True
    except Exception as e:
        print(f"\n❌ Error installing packages: {str(e)}")
        return False

def upgrade_aws_cli():
    """
    Upgrades AWS CLI to version 2 with user-level installation.
    Returns: bool indicating success/failure
    """
    try:
        home = os.path.expanduser("~")
        aws_cli_dir = os.path.join(home, '.aws-cli-v2')
        bin_dir = os.path.join(home, 'bin')
        
        print("📦 Installing AWS CLI v2...")
        
        # Clean up any previous installation files
        subprocess.run(['rm', '-f', 'awscliv2.zip'], check=False)
        subprocess.run(['rm', '-rf', 'aws'], check=False)
        
        print("  ↳ Downloading installer...")
        subprocess.check_call([
            'curl',
            'https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip',
            '-o',
            'awscliv2.zip',
            '--silent',
            '--show-error'
        ])
        
        print("  ↳ Extracting files...")
        subprocess.check_call(['unzip', '-q', '-o', 'awscliv2.zip'])
        os.makedirs(bin_dir, exist_ok=True)
        
        print("  ↳ Installing AWS CLI v2...")
        subprocess.check_call([
            './aws/install',
            '--bin-dir', bin_dir,
            '--install-dir', aws_cli_dir,
            '--update'
        ])
        
        if bin_dir not in os.environ['PATH']:
            os.environ['PATH'] = f"{bin_dir}:{os.environ['PATH']}"
        
        subprocess.check_call(['rm', '-f', 'awscliv2.zip'])
        subprocess.check_call(['rm', '-rf', 'aws'])
        
        return True
    except Exception as e:
        print(f"\n❌ Error during AWS CLI installation: {str(e)}")
        return False

def verify_installation():
    """
    Verifies the installation of AWS CLI and packages.
    """
    try:
        result = subprocess.run(['aws', '--version'], capture_output=True, text=True)
        if result.returncode == 0:
            print(f"\nAWS CLI Version: {result.stdout.strip()}")
        
        for package in ['boto3', 'numpy', 'matplotlib']:
            try:
                __import__(package)
                print(f"✅ {package} successfully installed")
            except ImportError:
                print(f"❌ {package} installation verification failed")
    except Exception as e:
        print(f"Error during verification: {str(e)}")

def setup():
    """
    Main installation process with improved progress tracking.
    """
    print("🚀 Starting installation process...\n")
    
    if install_packages():
        print("\n✅ Package installation successful")
    else:
        print("\n❌ Package installation failed")
        return
    
    print("\n🔄 Upgrading AWS CLI to version 2...")
    if upgrade_aws_cli():
        print("\n✅ AWS CLI upgrade successful")
        verify_installation()
        
        print("\n🎉 Installation complete!")
        print("\n⚠️  IMPORTANT: Please restart your Jupyter kernel to ensure all changes take effect.")
        print("\nNext steps:")
        print("1. Restart the Jupyter kernel")
        print("2. Open '02-create-visualization-template.ipynb'")
        print("3. Follow the instructions to create your visualization templates")
    else:
        print("\n❌ AWS CLI upgrade failed")

if __name__ == "__main__":
    setup()
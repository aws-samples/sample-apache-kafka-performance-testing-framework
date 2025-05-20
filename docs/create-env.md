# CDK Environment Prerequisites

## 1. Install and Configure Docker on Amazon Linux 2023

```bash
# Update system packages
sudo dnf update

# Install Docker 
sudo dnf install docker

# Start Docker service
sudo systemctl start docker

# Enable Docker to start automatically with system boot
sudo systemctl enable docker

# Confirm the Docker service is running 
sudo systemctl status docker

# Add the ec2-user to the docker group so that you can run Docker commands without using sudo
sudo usermod -a -G docker ec2-user

# Apply the changes to the docker group
newgrp docker

# Verify that the ec2-user can run Docker commands without using sudo.
docker ps

# You should see the following output, confirming that Docker is installed and running:
CONTAINER ID   IMAGE     COMMAND   CREATED   STATUS    PORTS     NAMES
```

## 2. Install Node.js on Amazon Linux 2023

```bash
# Install Node Version Manager (nvm)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash

# Activate nvm 
source ~/.bashrc

# Use nvm to install the latest LTS version of Node.js
nvm install --lts

# Test that Node.js is installed and running correctly by typing the following
node -e "console.log('Running Node.js ' + process.version)"
```

## 3. Install TypeScript on Amazon Linux 2023

```bash
# Install TypeScript
npm -g install typescript

# Verify TypeScript installation
tsc --version
```

## 4. Install the AWS CDK CLI on Amazon Linux 2023

```bash
# Use the Node Package Manager to install the CDK CLI 
npm install -g aws-cdk

# Verify a successful CDK CLI installation
cdk --version
```

## 5. Install Git on Amazon Linux 2023

```bash
# Install Git on Amazon Linux 2023
sudo dnf install -y git

# Verify a successful Git installation
git --version
```
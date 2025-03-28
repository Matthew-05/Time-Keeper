import os
import sys
import requests
import re
import platform
import tempfile
import subprocess
import shutil
from packaging import version
from typing import Optional, Tuple, Dict, Any, List


class AutoUpdater:
    """
    A class to handle automatic updates from GitHub releases.
    
    This class checks a GitHub repository for new releases and can download and
    apply updates automatically.
    """
    
    def __init__(
        self,
        github_url: str,
        current_version: str,
        executable_name: str,
        app_directory: Optional[str] = None,
        timeout: int = 10,
        on_update_callback: Optional[callable] = None,
        auto_restart: bool = False,
        additional_assets: Optional[List[Dict[str, str]]] = None,
        github_token: Optional[str] = None  # New parameter
    ):
        """
        Initialize the AutoUpdater.
        
        Args:
            github_url: URL to the GitHub repository or releases page
                       (e.g., 'https://github.com/username/repo' or
                              'https://github.com/username/repo/releases')
            current_version: Current version of the application (e.g., '1.0.0')
            executable_name: Name of the application
            app_directory: Directory containing the application executable and assets
                          (defaults to the current directory)
            timeout: Timeout for HTTP requests in seconds
            on_update_callback: Function to call after update is downloaded but before it's applied
            auto_restart: Whether to automatically restart the application after update
            additional_assets: List of dictionaries with keys 'pattern' (regex to match asset name) 
                              and 'destination' (relative path from app_directory where to extract/copy the asset)
        """
        # Clean up the GitHub URL to ensure it's in the correct format
        self.github_url = github_url.rstrip('/')
        if 'github.com' not in self.github_url:
            raise ValueError("URL must be a GitHub URL")
            
        # Extract owner and repo from the URL
        match = re.search(r'github\.com/([^/]+)/([^/]+)', self.github_url)
        if not match:
            raise ValueError("Invalid GitHub URL")
            
        self.owner = match.group(1)
        self.repo = match.group(2)
        
        # Remove '/releases' from repo name if it's included
        if self.repo.endswith('/releases'):
            self.repo = self.repo[:-9]
        
        # Set up the API URL for the latest release
        self.api_url = f"https://api.github.com/repos/{self.owner}/{self.repo}/releases/latest"
        
        self.current_version = current_version
        self.executable_name = executable_name
        self.app_directory = os.path.abspath(app_directory or os.getcwd())
        self.timeout = timeout
        self.on_update_callback = on_update_callback
        self.auto_restart = auto_restart
        self.additional_assets = additional_assets or []
        
        # Default headers for GitHub API
        self.headers = {
            'User-Agent': f'{executable_name} AutoUpdater',
        }
        if github_token:
            self.headers['Authorization'] = f'token {github_token}'
            
        # Determine the asset pattern based on platform and executable name
        system = platform.system().lower()
        if system == 'windows':
            self.asset_pattern = fr'{re.escape(executable_name)}.exe'
        elif system == 'darwin':
            self.asset_pattern = fr'{re.escape(executable_name)}.*\.dmg'
        elif system == 'linux':
            self.asset_pattern = fr'{re.escape(executable_name)}.*\.(?:AppImage|deb|rpm)'
        else:
            self.asset_pattern = fr'{re.escape(executable_name)}.*'
            
        # State variables
        self.latest_version = None
        self.latest_release_data = None
        self.update_available = False
        self.download_url = None
        self.downloaded_file = None
        self.downloaded_additional_assets = {}  # To track downloaded additional assets
        self.temp_dir = tempfile.mkdtemp(prefix=f"{executable_name}_update_")
        
    def check_for_update(self) -> bool:
        """
        Check if an update is available.
        
        Returns:
            bool: True if an update is available, False otherwise
        """
        try:
            # Set up authentication headers
            headers = {
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': self.headers['User-Agent']
            }
            
            if 'Authorization' in self.headers:
                headers['Authorization'] = self.headers['Authorization']

            # Use the GitHub API endpoint
            api_url = f"https://api.github.com/repos/{self.owner}/{self.repo}/releases"

            response = requests.get(api_url, headers=headers, timeout=self.timeout)
            
            response.raise_for_status()
            
            # Get the latest release from the list of releases
            releases = response.json()
            if not releases:

                return False
                
            release_data = releases[0]  # Latest release is first in the list
            latest_version_str = release_data['tag_name'].lstrip('v')
            


            
            # Store the release data for later use
            self.latest_release_data = release_data
            self.latest_version = latest_version_str
            
            # Compare versions
            self.update_available = version.parse(latest_version_str) > version.parse(self.current_version)
            
            if self.update_available:
                # Find the appropriate asset to download
                assets = release_data.get('assets', [])

                
                for asset in assets:

                    if re.search(self.asset_pattern, asset['name'], re.IGNORECASE):
                        # For private repos, use the asset's API URL 
                        self.download_url = asset['browser_download_url']
                        self.asset_id = asset['id']  # Store the asset ID for API download

                        break
                
                if not self.download_url:

                    self.update_available = False
                    return False
                    
                # Check for additional assets
                for additional_asset in self.additional_assets:
                    pattern = additional_asset['pattern']
                    found = False
                    for asset in assets:
                        if re.search(pattern, asset['name'], re.IGNORECASE):
                            additional_asset['url'] = asset['browser_download_url']
                            additional_asset['filename'] = asset['name']
                            additional_asset['id'] = asset['id']  # Store asset ID

                            found = True
                            break
                    if not found:
                        print(f"No matching asset found for pattern: {pattern}")
                        
            return self.update_available
                
        except requests.exceptions.HTTPError as e:
            print(f"HTTP Error: {e.response.status_code} - {e.response.text}")
            return False
        except Exception as e:
            import traceback
            traceback.print_exc()
            return False

            
    def get_most_recent_version(self) -> Optional[str]:
        """
        Get the most recent version available.
        
        Returns:
            str: The most recent version string, or None if it couldn't be determined
        """
        if self.latest_version:
            return self.latest_version
            
        # If we haven't checked yet, check now
        if self.check_for_update():
            return self.latest_version
            
        return None
        
    def get_release_notes(self) -> Optional[str]:
        """
        Get the release notes for the latest version.
        
        Returns:
            str: The release notes, or None if not available
        """
        if self.latest_release_data:
            return self.latest_release_data.get('body')
        return None
        
    def download_update(self) -> Optional[str]:
        """
        Download the latest update using GitHub API for private repositories.
        
        Returns:
            str: Path to the downloaded file, or None if download failed
        """
        if not self.download_url:
            if not self.check_for_update() or not self.download_url:
                return None
                
        try:
            # Set up authentication headers for GitHub API
            headers = {
                'Accept': 'application/octet-stream',
                'User-Agent': self.headers['User-Agent']
            }
            
            # Add authorization if we have a token
            if 'Authorization' in self.headers:
                headers['Authorization'] = self.headers['Authorization']

            # Create a temporary file to store the download
            file_name = os.path.basename(self.download_url)

            download_path = os.path.join(self.temp_dir, file_name)
            
            # Try direct download with authentication first

            response = requests.get(self.download_url, stream=True, timeout=self.timeout, headers=headers)
            
            # If direct download failed, try the API URL
            if response.status_code == 404:

                # For private repositories, we need to use the GitHub API
                api_url = f"https://api.github.com/repos/{self.owner}/{self.repo}/releases/assets/{self.asset_id}"

                
                # Make sure to update the Accept header for the API request
                headers['Accept'] = 'application/octet-stream'
                
                response = requests.get(api_url, stream=True, timeout=self.timeout, headers=headers)
            
            response.raise_for_status()
            
            # Save the file
            with open(download_path, 'wb') as f:
                for chunk in response.iter_content(chunk_size=8192):
                    f.write(chunk)
                    
            self.downloaded_file = download_path

            
            # Download additional assets with authentication
            for asset in self.additional_assets:
                if 'url' in asset and 'id' in asset:
                    try:
                        file_name = asset['filename']
                        asset_path = os.path.join(self.temp_dir, file_name)
                        

                        
                        # Try direct download first
                        response = requests.get(asset['url'], stream=True, timeout=self.timeout, headers=headers)
                        
                        # If direct download failed, try the API URL
                        if response.status_code == 404:

                            api_url = f"https://api.github.com/repos/{self.owner}/{self.repo}/releases/assets/{asset['id']}"

                            response = requests.get(api_url, stream=True, timeout=self.timeout, headers=headers)
                        
                        response.raise_for_status()
                        
                        # Save the file
                        with open(asset_path, 'wb') as f:
                            for chunk in response.iter_content(chunk_size=8192):
                                f.write(chunk)
                        
                        # Handle the destination path
                        destination = asset.get('destination')
                        if destination:
                            if os.path.isabs(destination):
                                full_destination = destination
                            else:
                                full_destination = os.path.join(self.app_directory, destination)
                        else:
                            full_destination = os.path.join(self.app_directory, os.path.basename(file_name))
                                
                        self.downloaded_additional_assets[asset['pattern']] = {
                            'path': asset_path,
                            'destination': full_destination
                        }

                    except Exception as e:
                        print(f"Error downloading additional asset {asset.get('filename', 'unknown')}: {e}")
                        print(f"Error details: {str(e)}")
            
            return download_path
            
        except Exception as e:
            print(f"Error downloading update: {e}")
            import traceback
            traceback.print_exc()
            return None
            
    def apply_update(self) -> bool:
        """
        Apply the downloaded update.
        
        Returns:
            bool: True if the update was successfully applied, False otherwise
        """
        if not self.downloaded_file:
            if not self.download_update():
                print("No update to apply.")
                return False
                
        # Call the callback if provided
        if self.on_update_callback:
            try:
                self.on_update_callback(self.downloaded_file, self.latest_version, self.downloaded_additional_assets)
            except Exception as e:
                print(f"Error in update callback: {e}")
                
        # Apply the update based on the file type and platform
        try:
            system = platform.system().lower()
            
            if system == 'windows':
                if self.downloaded_file.endswith('.exe'):
                    # For Windows executables, we can either run the installer or replace the executable
                    executable_path = os.path.join(self.app_directory, f"{self.executable_name}.exe")
                    
                    # Check if the filename contains installer-related keywords
                    is_installer = any(keyword in self.downloaded_file.lower() for keyword in 
                                    ['setup', 'install', 'installer'])
                    
                    if is_installer:
                        if self.auto_restart:
                            subprocess.Popen([self.downloaded_file])
                            sys.exit(0)
                        else:
                            return True
                    else:
                        # Extract any zip files in additional assets before creating the batch script
                        extracted_assets = self.extract_additional_assets()
                        
                        # It's a direct executable, need to handle "file in use" issue
                        # Create a batch script that will wait for our process to exit and then perform the update
                        update_script_path = os.path.join(self.temp_dir, "update_script.bat")
                        with open(update_script_path, "w") as f:
                            f.write('@echo off\n')
                            f.write('echo ===== Avalon Auto Updater =====\n')
                            f.write('echo Waiting for application to close...\n')
                            
                            # Get the process ID to monitor more accurately
                            f.write(f'set EXE_NAME={os.path.basename(executable_path)}\n')
                            f.write('echo Waiting for %EXE_NAME% to close\n')
                            f.write('timeout /t 3 /nobreak > NUL\n')  # Initial wait
                            
                            # More robust process checking
                            f.write(':wait_loop\n')
                            f.write('tasklist /FI "IMAGENAME eq %EXE_NAME%" 2>NUL | find "%EXE_NAME%" >NUL\n')
                            f.write('if %ERRORLEVEL% EQU 0 (\n')
                            f.write('    echo %EXE_NAME% is still running, waiting...\n')
                            f.write('    timeout /t 2 /nobreak > NUL\n')
                            f.write('    goto :wait_loop\n')
                            f.write(')\n')
                            
                            f.write('echo %EXE_NAME% has closed\n')
                            f.write('echo Waiting for file handles to be released...\n')
                            f.write('timeout /t 3 /nobreak > NUL\n')  # Wait to ensure file handles are released
                            
                            # Make a backup of the current executable if it exists
                            f.write(f'if exist "{executable_path}" (\n')
                            f.write(f'  echo Creating backup of current version...\n')
                            f.write(f'  if exist "{executable_path}.bak" del "{executable_path}.bak"\n')
                            f.write(f'  copy /Y "{executable_path}" "{executable_path}.bak"\n')
                            f.write(f'  if errorlevel 1 (\n')
                            f.write(f'    echo Failed to create backup. Retrying after delay...\n')
                            f.write(f'    timeout /t 5 /nobreak > NUL\n')
                            f.write(f'    copy /Y "{executable_path}" "{executable_path}.bak"\n')
                            f.write(f'  )\n')
                            f.write(')\n')
                            
                            # Copy the new executable with better error handling
                            f.write(f'echo Copying new version from {self.downloaded_file}...\n')
                            f.write(f'copy /Y "{self.downloaded_file}" "{executable_path}"\n')
                            f.write(f'if errorlevel 1 (\n')
                            f.write(f'  echo ERROR: Failed to copy new executable. Retrying after delay...\n')
                            f.write(f'  timeout /t 5 /nobreak > NUL\n')
                            f.write(f'  copy /Y "{self.downloaded_file}" "{executable_path}"\n')
                            f.write(f'  if errorlevel 1 (\n')
                            f.write(f'    echo CRITICAL ERROR: Failed to copy new executable after retry\n')
                            f.write(f'    echo From: {self.downloaded_file}\n')
                            f.write(f'    echo To: {executable_path}\n')
                            f.write(f'    echo Restoring backup...\n')
                            f.write(f'    if exist "{executable_path}.bak" copy /Y "{executable_path}.bak" "{executable_path}"\n')
                            f.write(f'    pause\n')
                            f.write(f'    exit /b 1\n')
                            f.write(f'  )\n')
                            f.write(f') else (\n')
                            f.write(f'  echo Successfully copied new executable\n')
                            f.write(f')\n')
                            
                            # Process extracted assets with better error handling
                            for pattern, asset_info in extracted_assets.items():
                                extracted_path = asset_info['extracted_path']
                                destination = asset_info['destination']
                                if os.path.exists(extracted_path) and destination:
                                    f.write(f'echo Processing extracted asset: {os.path.basename(extracted_path)}...\n')
                                    
                                    # Create destination directory if it doesn't exist
                                    f.write(f'if not exist "{destination}" mkdir "{destination}"\n')
                                    
                                    # Backup the existing directory if it exists
                                    f.write(f'if exist "{destination}" (\n')
                                    f.write(f'  echo Creating backup of current directory...\n')
                                    f.write(f'  if exist "{destination}.bak" rd /S /Q "{destination}.bak"\n')
                                    f.write(f'  xcopy /E /I /Y "{destination}" "{destination}.bak"\n')
                                    f.write(f')\n')
                                    
                                    # Remove existing directory contents
                                    f.write(f'echo Removing existing directory contents...\n')
                                    f.write(f'if exist "{destination}" rd /S /Q "{destination}"\n')
                                    f.write(f'mkdir "{destination}"\n')
                                    
                                    # Copy the extracted contents to the destination
                                    f.write(f'echo Copying extracted contents to {destination}...\n')
                                    f.write(f'xcopy /E /I /Y "{extracted_path}\\*" "{destination}"\n')
                                    f.write(f'if errorlevel 1 (\n')
                                    f.write(f'  echo Warning: Failed to copy extracted asset {os.path.basename(extracted_path)}\n')
                                    f.write(f'  echo Restoring backup...\n')
                                    f.write(f'  if exist "{destination}.bak" xcopy /E /I /Y "{destination}.bak\\*" "{destination}"\n')
                                    f.write(f') else (\n')
                                    f.write(f'  echo Successfully copied extracted asset\n')
                                    f.write(f')\n')
                            
                            # Process any non-extracted additional assets
                            for pattern, asset_info in self.downloaded_additional_assets.items():
                                if pattern not in extracted_assets:
                                    asset_path = asset_info['path']
                                    destination = asset_info['destination']
                                    if os.path.exists(asset_path) and destination:
                                        f.write(f'echo Processing additional asset: {os.path.basename(asset_path)}...\n')
                                        if os.path.isdir(destination):
                                            f.write(f'if not exist "{destination}" mkdir "{destination}"\n')
                                            f.write(f'echo Copying to {destination}...\n')
                                            f.write(f'copy /Y "{asset_path}" "{destination}\\{os.path.basename(asset_path)}"\n')
                                        else:
                                            dest_dir = os.path.dirname(destination)
                                            f.write(f'if not exist "{dest_dir}" mkdir "{dest_dir}"\n')
                                            f.write(f'echo Copying to {destination}...\n')
                                            f.write(f'copy /Y "{asset_path}" "{destination}"\n')
                                        f.write(f'if errorlevel 1 (\n')
                                        f.write(f'  echo Warning: Failed to copy additional asset {os.path.basename(asset_path)}\n')
                                        f.write(f') else (\n')
                                        f.write(f'  echo Successfully copied additional asset\n')
                                        f.write(f')\n')
                            
                            # Start the updated application after a delay
                            if self.auto_restart:
                                f.write(f'echo Update completed successfully\n')
                                f.write(f'echo Waiting before starting updated application...\n')
                                f.write(f'timeout /t 3 /nobreak > NUL\n')
                                f.write(f'echo Starting updated application...\n')
                                f.write(f'start "" "{executable_path}"\n')
                            else:
                                f.write(f'echo Update completed successfully\n')
                            
                            # Clean up temp directory
                            f.write(f'echo Cleaning up temporary files...\n')
                            f.write(f'rd /S /Q "{self.temp_dir}"\n')
                            f.write('echo Update process completed\n')
                            f.write('timeout /t 3 /nobreak > NUL\n')
                        
                        # Make the update script executable
                        os.chmod(update_script_path, 0o755)
                        
                        # Start the update script and exit this process
                        print(f'Starting update script: {update_script_path}')
                        subprocess.Popen(['cmd', '/c', update_script_path], 
                                        shell=True, 
                                        creationflags=subprocess.CREATE_NEW_CONSOLE)
                        
                        # Exit the current process to allow the update to proceed
                        if self.auto_restart:
                            print('Restarting application...')
                            os._exit(0)
                        return True
                        
            elif system == 'darwin':
                if self.downloaded_file.endswith('.dmg'):
                    # For macOS DMG files, mount and copy the application
                    mount_point = tempfile.mkdtemp()

                    subprocess.run(['hdiutil', 'attach', self.downloaded_file, '-mountpoint', mount_point])
                    
                    # Find the .app bundle
                    app_path = None
                    for root, dirs, files in os.walk(mount_point):
                        for dir_name in dirs:
                            if dir_name.endswith('.app'):
                                app_path = os.path.join(root, dir_name)
                                break
                        if app_path:
                            break
                            
                    if app_path:
                        # Copy the app to the Applications folder

                        subprocess.run(['cp', '-R', app_path, '/Applications/'])
                        subprocess.run(['hdiutil', 'detach', mount_point])
                        
                        if self.auto_restart:
                            app_name = f'/Applications/{os.path.basename(app_path)}'

                            subprocess.Popen(['open', app_name])
                            sys.exit(0)
                        return True
                        
            elif system == 'linux':
                if self.downloaded_file.endswith('.AppImage'):
                    # For AppImage, make it executable and replace the current one
                    os.chmod(self.downloaded_file, 0o755)
                    executable_path = os.path.join(self.app_directory, self.executable_name)
                    if not executable_path.endswith('.AppImage'):
                        executable_path += '.AppImage'
                        


                    
                    if os.path.exists(executable_path):
                        # Make a backup of the current executable
                        backup_path = f"{executable_path}.bak"
                        if os.path.exists(backup_path):
                            os.remove(backup_path)

                        shutil.copy2(executable_path, backup_path)
                        
                    # Replace with the new executable

                    shutil.copy2(self.downloaded_file, executable_path)
                    
                    if self.auto_restart:

                        subprocess.Popen([executable_path])
                        sys.exit(0)
                    return True
                    
                elif self.downloaded_file.endswith('.deb'):
                    # For Debian packages

                    subprocess.run(['sudo', 'dpkg', '-i', self.downloaded_file])
                    if self.auto_restart:

                        subprocess.Popen([self.executable_name])
                        sys.exit(0)
                    return True
                    
                elif self.downloaded_file.endswith('.rpm'):
                    # For RPM packages

                    subprocess.run(['sudo', 'rpm', '-U', self.downloaded_file])
                    if self.auto_restart:

                        subprocess.Popen([self.executable_name])
                        sys.exit(0)
                    return True
            
            # Process additional assets
            for pattern, asset_info in self.downloaded_additional_assets.items():
                asset_path = asset_info['path']
                destination = asset_info['destination']
                
                if destination and os.path.exists(asset_path): 
                    # Create destination directory if it doesn't exist
                    dest_dir = os.path.dirname(destination)
                    if dest_dir:
                        os.makedirs(dest_dir, exist_ok=True)

                    
                    # Handle different file types
                    if asset_path.endswith(('.zip', '.tar.gz', '.tgz')):
                        import zipfile
                        import tarfile
                        
                        # If destination is a directory, extract there
                        if os.path.isdir(destination) or not os.path.splitext(destination)[1]:
                            extract_dir = destination
                        else:
                            # If destination is a file path, extract to its parent directory
                            extract_dir = os.path.dirname(destination)
                            
                        if not os.path.exists(extract_dir):
                            os.makedirs(extract_dir, exist_ok=True)
                            
                        if asset_path.endswith('.zip'):
                            with zipfile.ZipFile(asset_path, 'r') as zip_ref:
                                print(f'Extracting {asset_path} to {extract_dir}')
                                zip_ref.extractall(extract_dir)
                        else:  # tar.gz or tgz

                            with tarfile.open(asset_path, 'r:gz') as tar_ref:
                                tar_ref.extractall(extract_dir)
                    else:
                        # Just copy the file
                        if os.path.isdir(destination):
                            final_path = os.path.join(destination, os.path.basename(asset_path))

                            shutil.copy2(asset_path, final_path)
                        else:

                            shutil.copy2(asset_path, destination)
                    

            

            return True
            
        except Exception as e:
            print(f"Error applying update: {e}")
            import traceback
            traceback.print_exc()
            return False

    def extract_additional_assets(self):
        """
        Extract any zip files in additional assets before creating the update script.
        Returns a dictionary mapping asset patterns to their extracted paths.
        """
        import zipfile
        extracted_assets = {}
        
        for pattern, asset_info in self.downloaded_additional_assets.items():
            asset_path = asset_info['path']
            destination = asset_info['destination']
            
            if asset_path.endswith('.zip'):
                # Create an extraction directory within the temp directory
                extract_dir = os.path.join(self.temp_dir, f"extracted_{os.path.basename(asset_path).replace('.zip', '')}")
                os.makedirs(extract_dir, exist_ok=True)
                
                print(f'Pre-extracting {asset_path} to {extract_dir}')
                with zipfile.ZipFile(asset_path, 'r') as zip_ref:
                    zip_ref.extractall(extract_dir)
                
                # Update the asset info with the extracted path
                extracted_assets[pattern] = {
                    'original_path': asset_path,
                    'extracted_path': extract_dir,
                    'destination': destination
                }
        
        return extracted_assets
            
    def update(self) -> bool:
        """
        Check for, download, and apply an update if available.
        
        Returns:
            bool: True if an update was applied, False otherwise
        """
        if self.check_for_update():
            if self.download_update():
                return self.apply_update()
        return False
        
    def get_update_info(self) -> Dict[str, Any]:
        """
        Get information about the available update.
        
        Returns:
            dict: Information about the update
        """
        if not self.latest_release_data:
            self.check_for_update()
            
        if not self.latest_release_data:
            return {
                'update_available': False,
                'current_version': self.current_version,
                'latest_version': None,
                'release_notes': None,
                'download_url': None,
            }
            
        return {
            'update_available': self.update_available,
            'current_version': self.current_version,
            'latest_version': self.latest_version,
            'release_notes': self.get_release_notes(),
            'download_url': self.download_url,
            'published_at': self.latest_release_data.get('published_at'),
            'release_url': self.latest_release_data.get('html_url'),
            'additional_assets': [
                {
                    'pattern': asset.get('pattern'),
                    'url': asset.get('url'),
                    'filename': asset.get('filename'),
                    'destination': asset.get('destination')
                } for asset in self.additional_assets if 'url' in asset
            ]
        }
        
    def cleanup(self) -> None:
        """
        Clean up any temporary files created during the update process.
        """
        try:
            # Clean up the entire temp directory
            if os.path.exists(self.temp_dir):
                shutil.rmtree(self.temp_dir)
                
            self.downloaded_file = None
            self.downloaded_additional_assets = {}
        except Exception as e:
            print(f"Error cleaning up temporary files: {e}")

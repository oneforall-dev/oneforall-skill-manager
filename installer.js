#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const http = require('http');
const { exec } = require('child_process');
const os = require('os');

// Standard agent paths
const GLOBAL_CONFIG_DIR = path.join(os.homedir(), '.gemini', 'config');
const GLOBAL_CODEX_DIR = path.join(os.homedir(), '.codex');
const GLOBAL_CLAUDE_DIR = path.join(os.homedir(), '.claude');
const GLOBAL_AGENTS_DIR = path.join(os.homedir(), '.agents');

// Helper to parse YAML frontmatter (name & description)
function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return { name: '', description: '' };
  
  const yamlSection = match[1];
  const metadata = { name: '', description: '' };
  
  const nameMatch = yamlSection.match(/^name:\s*(.+)$/m);
  const descMatch = yamlSection.match(/^description:\s*(.+)$/m);
  
  if (nameMatch) metadata.name = nameMatch[1].trim().replace(/^['"]|['"]$/g, '');
  if (descMatch) metadata.description = descMatch[1].trim().replace(/^['"]|['"]$/g, '');
  
  return metadata;
}

// Helper to list skills
function getSkillsInDir(customizationRoot) {
  const skillsDir = path.join(customizationRoot, 'skills');
  if (!fs.existsSync(skillsDir)) return [];
  
  try {
    const folders = fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name);
      
    const skills = [];
    for (const folder of folders) {
      const skillPath = path.join(skillsDir, folder);
      const skillMdPath = path.join(skillPath, 'SKILL.md');
      
      let hasSkillMd = fs.existsSync(skillMdPath);
      
      // Auto-heal: If folder does not have SKILL.md at the root, check if there's a SKILL.md nested inside (ignore hidden directories)
      if (!hasSkillMd && !folder.startsWith('.')) {
        const nestedDirs = [];
        findSkillDirs(skillPath, nestedDirs);
        if (nestedDirs.length > 0) {
          const skillSrcDir = nestedDirs[0]; // Take the first found skill folder
          console.log(`Auto-healing nested skill folder: ${folder}. Moving files from ${skillSrcDir} to ${skillPath}`);
          
          try {
            // To restructure in place:
            // 1. Copy files from skillSrcDir to a temp location
            const tempPath = path.join(os.tmpdir(), 'agy-heal-temp-' + Date.now());
            fs.mkdirSync(tempPath, { recursive: true });
            fs.cpSync(skillSrcDir, tempPath, { recursive: true });
            
            // 2. Clear out the destination folder
            fs.rmSync(skillPath, { recursive: true, force: true });
            
            // 3. Copy files back from tempPath to skillPath
            fs.mkdirSync(skillPath, { recursive: true });
            fs.cpSync(tempPath, skillPath, { recursive: true });
            
            // 4. Cleanup temp location
            fs.rmSync(tempPath, { recursive: true, force: true });
            
            hasSkillMd = true;
            console.log(`Successfully auto-healed ${folder}!`);
          } catch (healErr) {
            console.error(`Failed to auto-heal folder ${folder}:`, healErr);
          }
        }
      }
      
      let metadata = { name: folder, description: 'No description found.' };
      let skillContent = '';
      
      if (hasSkillMd) {
        skillContent = fs.readFileSync(skillMdPath, 'utf8');
        const parsed = parseFrontmatter(skillContent);
        if (parsed.name) metadata.name = parsed.name;
        if (parsed.description) metadata.description = parsed.description;
      }
      
      // Detect if it is a Git repository
      const isGit = fs.existsSync(path.join(skillPath, '.git'));
      
      skills.push({
        folderName: folder,
        path: skillPath,
        name: metadata.name,
        description: metadata.description,
        hasSkillMd,
        content: skillContent,
        isGit
      });
    }
    return skills;
  } catch (err) {
    console.error(`Error reading skills in ${customizationRoot}:`, err);
    return [];
  }
}

// CLI Mode execution
function runCLI(args) {
  const helpText = `
Oneforall Skill Manager CLI
Usage:
  node installer.js [options]

Options:
  -i, --install <source>   Install a skill from a Git URL, local filepath, or remote URL.
  -g, --global             Target the Global Customizations directory (~/.gemini/config).
  -w, --workspace <path>   Target a Workspace Customizations directory (defaults to current folder).
  -l, --list               List currently installed skills.
  -h, --help               Show this help message.

If no options are provided, the installer starts in Web GUI mode.
`;

  if (args.includes('-h') || args.includes('--help')) {
    console.log(helpText);
    process.exit(0);
  }

  // Parse target
  let targetType = 'workspace';
  let targetPath = process.cwd();
  
  if (args.includes('-g') || args.includes('--global')) {
    targetType = 'global';
    targetPath = GLOBAL_CONFIG_DIR;
  } else {
    const wIndex = args.indexOf('-w') !== -1 ? args.indexOf('-w') : args.indexOf('--workspace');
    if (wIndex !== -1 && args[wIndex + 1]) {
      targetPath = path.resolve(args[wIndex + 1]);
    }
  }

  // List skills option
  if (args.includes('-l') || args.includes('--list')) {
    const customizationRoot = targetType === 'global' ? GLOBAL_CONFIG_DIR : path.join(targetPath, '.agents');
    console.log(`Listing skills in: ${customizationRoot}`);
    const list = getSkillsInDir(customizationRoot);
    if (list.length === 0) {
      console.log('No skills installed.');
    } else {
      list.forEach((s, idx) => {
        console.log(`\n[${idx + 1}] ${s.name} (${s.folderName})`);
        console.log(`    Path: ${s.path}`);
        console.log(`    Type: ${s.isGit ? 'Git Repository' : 'Direct Skill'}`);
        console.log(`    Description: ${s.description}`);
      });
    }
    process.exit(0);
  }

  // Install skill option
  const iIndex = args.indexOf('-i') !== -1 ? args.indexOf('-i') : args.indexOf('--install');
  if (iIndex !== -1 && args[iIndex + 1]) {
    const source = args[iIndex + 1];
    const customizationRoot = targetType === 'global' ? GLOBAL_CONFIG_DIR : path.join(targetPath, '.agents');
    
    console.log(`Installing skill from: "${source}"`);
    console.log(`Target path: "${customizationRoot}"`);
    
    installSkill(source, customizationRoot)
      .then(res => {
        console.log(`Successfully installed skill: ${res.name}!`);
        process.exit(0);
      })
      .catch(err => {
        console.error('Installation failed:', err.message);
        process.exit(1);
      });
  } else {
    console.log('Invalid command arguments.');
    console.log(helpText);
    process.exit(1);
  }
}

// Helper to recursively find all directories containing a SKILL.md file
function findSkillDirs(dir, fileList = []) {
  if (!fs.existsSync(dir)) return fileList;
  const files = fs.readdirSync(dir);
  let hasSkillMd = false;
  
  for (const file of files) {
    const filePath = path.join(dir, file);
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (e) {
      continue;
    }
    
    if (stat.isDirectory()) {
      if (file === '.git') continue;
      findSkillDirs(filePath, fileList);
    } else if (file.toLowerCase() === 'skill.md') {
      hasSkillMd = true;
    }
  }
  
  if (hasSkillMd) {
    fileList.push(dir);
  }
  return fileList;
}

// Function to handle the install business logic
function installSkill(source, customizationRoot) {
  return new Promise((resolve, reject) => {
    const skillsDir = path.join(customizationRoot, 'skills');
    
    // Ensure parent directories exist
    if (!fs.existsSync(skillsDir)) {
      fs.mkdirSync(skillsDir, { recursive: true });
    }

    // Check if it is a Git source
    const isGit = source.startsWith('http') && (
      source.endsWith('.git') ||
      source.includes('github.com/') ||
      source.includes('gitlab.com/') ||
      source.includes('raw.githubusercontent.com/')
    );

    if (isGit) {
      // Determine repo URL and sub-path if it is a tree, blob or raw URL
      const githubSubRegex = /https:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:tree|blob)\/([^/]+)\/(.+)/;
      const gitlabSubRegex = /https:\/\/gitlab\.com\/([^/]+)\/([^/]+)\/-\/(?:tree|blob)\/([^/]+)\/(.+)/;
      const rawGithubRegex = /https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)/;

      let repoUrl = source;
      let isTreeUrl = false;
      let subPath = '';
      let branchName = null;

      let match = source.match(githubSubRegex);
      if (match) {
        isTreeUrl = true;
        repoUrl = `https://github.com/${match[1]}/${match[2]}.git`;
        branchName = match[3];
        let pathPart = match[4].replace(/\/$/, '');
        if (pathPart.toLowerCase().endsWith('.md')) {
          subPath = path.dirname(pathPart);
        } else {
          subPath = pathPart;
        }
      } else if ((match = source.match(gitlabSubRegex))) {
        isTreeUrl = true;
        repoUrl = `https://gitlab.com/${match[1]}/${match[2]}.git`;
        branchName = match[3];
        let pathPart = match[4].replace(/\/$/, '');
        if (pathPart.toLowerCase().endsWith('.md')) {
          subPath = path.dirname(pathPart);
        } else {
          subPath = pathPart;
        }
      } else if ((match = source.match(rawGithubRegex))) {
        isTreeUrl = true;
        repoUrl = `https://github.com/${match[1]}/${match[2]}.git`;
        branchName = match[3];
        let pathPart = match[4].replace(/\/$/, '');
        if (pathPart.toLowerCase().endsWith('.md')) {
          subPath = path.dirname(pathPart);
        } else {
          subPath = pathPart;
        }
      } else {
        if (repoUrl.endsWith('/SKILL.md') || repoUrl.endsWith('/skill.md')) {
          repoUrl = repoUrl.replace(/\/[^/]+\.md$/i, '');
        }
      }

      if (subPath === '.') subPath = '';

      // Create a temporary directory for cloning with unique suffix
      const tempDir = path.join(os.tmpdir(), 'agy-skill-clone-' + Date.now() + '-' + Math.random().toString(36).substring(2, 7));
      console.log(`Cloning Git repository into temp folder ${tempDir}...`);

      let cloneCmd = `git clone --depth 1`;
      if (branchName) {
        cloneCmd += ` -b "${branchName}"`;
      }
      cloneCmd += ` "${repoUrl}" "${tempDir}"`;

      exec(cloneCmd, (err, stdout, stderr) => {
        const processClonedRepo = () => {
          try {
            const searchRoot = subPath ? path.join(tempDir, subPath) : tempDir;
            
            if (!fs.existsSync(searchRoot)) {
              if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
              return reject(new Error(`Path "${subPath}" not found in cloned repository.`));
            }

            // Find all directories containing SKILL.md recursively
            const skillDirs = [];
            findSkillDirs(searchRoot, skillDirs);

            if (skillDirs.length === 0) {
              if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
              return reject(new Error(`No SKILL.md file found in the repository.`));
            }

            const installedSkills = [];

            for (const skillSrcDir of skillDirs) {
              // Read frontmatter to get skill name
              const skillMdPath = path.join(skillSrcDir, 'SKILL.md');
              const content = fs.readFileSync(skillMdPath, 'utf8');
              const meta = parseFrontmatter(content);

              // Determine folder name
              let folderName = '';
              if (meta.name) {
                folderName = meta.name.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
              } else {
                folderName = path.basename(skillSrcDir).toLowerCase().replace(/[^a-z0-9_-]/g, '_');
              }

              // Guard against temp/generic names
              if (folderName === 'temp' || folderName.startsWith('agy-skill-clone-')) {
                folderName = 'git-skill-' + Date.now();
              }

              const targetFolder = path.join(skillsDir, folderName);

              // Overwrite existing folder if it exists
              if (fs.existsSync(targetFolder)) {
                console.log(`Overwriting existing skill folder: ${targetFolder}`);
                fs.rmSync(targetFolder, { recursive: true, force: true });
              }

              console.log(`Installing skill "${meta.name || folderName}" to ${targetFolder}`);
              fs.mkdirSync(targetFolder, { recursive: true });
              fs.cpSync(skillSrcDir, targetFolder, { recursive: true });

              // Clean up nested .git folder
              const copiedGitFolder = path.join(targetFolder, '.git');
              if (fs.existsSync(copiedGitFolder)) {
                fs.rmSync(copiedGitFolder, { recursive: true, force: true });
              }

              installedSkills.push({
                name: meta.name || folderName,
                folderName: folderName,
                path: targetFolder
              });
            }

            // Cleanup temp directory
            fs.rmSync(tempDir, { recursive: true, force: true });

            // Return the first installed skill
            resolve(installedSkills[0]);
          } catch (processErr) {
            if (fs.existsSync(tempDir)) {
              fs.rmSync(tempDir, { recursive: true, force: true });
            }
            reject(processErr);
          }
        };

        if (err) {
          // If depth 1 or branch clone fails, try normal full clone
          console.log('Depth 1 clone failed, trying normal clone...');
          exec(`git clone "${repoUrl}" "${tempDir}"`, (err2, stdout2, stderr2) => {
            if (err2) {
              if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
              return reject(new Error(`Git clone failed: ${stderr2 || err2.message}`));
            }
            processClonedRepo();
          });
        } else {
          processClonedRepo();
        }
      });
    }
    // 2. Check if source is a remote markdown file URL
    else if (source.startsWith('http') && (source.endsWith('.md') || source.includes('/raw/'))) {
      console.log(`Downloading Remote SKILL.md from ${source}...`);
      
      const client = source.startsWith('https') ? require('https') : require('http');
      client.get(source, (res) => {
        if (res.statusCode !== 200) {
          return reject(new Error(`Failed to download file. Status Code: ${res.statusCode}`));
        }

        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          const meta = parseFrontmatter(data);
          const skillName = meta.name || 'downloaded-skill-' + Date.now();
          const folderName = skillName.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
          const targetFolder = path.join(skillsDir, folderName);

          if (fs.existsSync(targetFolder)) {
            return reject(new Error(`Skill folder already exists: ${targetFolder}`));
          }

          fs.mkdirSync(targetFolder, { recursive: true });
          fs.writeFileSync(path.join(targetFolder, 'SKILL.md'), data, 'utf8');
          resolve({ name: skillName, folderName, path: targetFolder });
        });
      }).on('error', err => reject(err));
    }
    // 3. Check if source is a local filepath to a file
    else if (fs.existsSync(source) && fs.statSync(source).isFile()) {
      try {
        console.log(`Reading local skill file from ${source}...`);
        const data = fs.readFileSync(source, 'utf8');
        const meta = parseFrontmatter(data);
        const skillName = meta.name || path.basename(source, '.md');
        const folderName = skillName.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
        const targetFolder = path.join(skillsDir, folderName);

        if (fs.existsSync(targetFolder)) {
          return reject(new Error(`Skill folder already exists: ${targetFolder}`));
        }

        fs.mkdirSync(targetFolder, { recursive: true });
        fs.writeFileSync(path.join(targetFolder, 'SKILL.md'), data, 'utf8');
        resolve({ name: skillName, folderName, path: targetFolder });
      } catch (err) {
        reject(err);
      }
    }
    // 3b. Check if source is a local directory path
    else if (fs.existsSync(source) && fs.statSync(source).isDirectory()) {
      try {
        console.log(`Copying local skill directory from ${source}...`);
        const skillMdPath = path.join(source, 'SKILL.md');
        if (!fs.existsSync(skillMdPath)) {
          return reject(new Error(`Source directory does not contain a SKILL.md file: ${source}`));
        }
        const data = fs.readFileSync(skillMdPath, 'utf8');
        const meta = parseFrontmatter(data);
        const skillName = meta.name || path.basename(source);
        const folderName = skillName.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
        const targetFolder = path.join(skillsDir, folderName);

        if (fs.existsSync(targetFolder)) {
          fs.rmSync(targetFolder, { recursive: true, force: true });
        }

        fs.mkdirSync(targetFolder, { recursive: true });
        fs.cpSync(source, targetFolder, { recursive: true });
        resolve({ name: skillName, folderName, path: targetFolder });
      } catch (err) {
        reject(err);
      }
    }
    // 4. Raw Text Content (Markdown string passed directly)
    else if (source.trim().startsWith('---')) {
      const meta = parseFrontmatter(source);
      const skillName = meta.name || 'raw-skill-' + Date.now();
      const folderName = skillName.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
      const targetFolder = path.join(skillsDir, folderName);

      if (fs.existsSync(targetFolder)) {
        return reject(new Error(`Skill folder already exists: ${targetFolder}`));
      }

      fs.mkdirSync(targetFolder, { recursive: true });
      fs.writeFileSync(path.join(targetFolder, 'SKILL.md'), source, 'utf8');
      resolve({ name: skillName, folderName, path: targetFolder });
    }
    // 5. Error case
    else {
      reject(new Error('Invalid skill source format. Must be a Git URL, Git tree/subfolder URL, HTTP .md URL, existing file path, or raw markdown text starting with frontmatter.'));
    }
  });
}

// Web GUI Server Mode
function startGUIServer() {
  const PORT = 3000;
  const PUBLIC_DIR = path.join(__dirname, 'public');

  const MIME_TYPES = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml'
  };

  const server = http.createServer((req, res) => {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    // 1. API - Get workspace path and folder availability
    if (req.url === '/api/detect-workspace' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        defaultWorkspace: process.cwd(),
        globalConfigDir: GLOBAL_CONFIG_DIR
      }));
      return;
    }

    // 1b. API - Check Skill installations across targets
    if (req.url.startsWith('/api/check-installations') && req.method === 'GET') {
      const urlParams = new URL(req.url, `http://${req.headers.host}`);
      const folderName = urlParams.searchParams.get('folderName');
      const workspacePath = urlParams.searchParams.get('workspacePath') || process.cwd();

      if (!folderName) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'folderName parameter is required.' }));
        return;
      }

      const checkPath = (root) => {
        const fullPath = path.join(root, 'skills', folderName);
        return {
          installed: fs.existsSync(fullPath) && fs.existsSync(path.join(fullPath, 'SKILL.md')),
          path: fullPath
        };
      };

      const result = {
        claude: checkPath(GLOBAL_CLAUDE_DIR),
        global: checkPath(GLOBAL_CONFIG_DIR),
        opendesign: checkPath(GLOBAL_CLAUDE_DIR),
        codex: checkPath(GLOBAL_CODEX_DIR),
        workspace: checkPath(path.join(workspacePath, '.agents'))
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, installations: result }));
      return;
    }

    // 2. API - List Skills
    if (req.url.startsWith('/api/skills') && req.method === 'GET') {
      const urlParams = new URL(req.url, `http://${req.headers.host}`);
      const target = urlParams.searchParams.get('target') || 'workspace';
      const workspacePath = urlParams.searchParams.get('workspacePath') || process.cwd();
      
      let customizationRoot = '';
      if (target === 'global') {
        customizationRoot = GLOBAL_CONFIG_DIR;
      } else if (target === 'codex') {
        customizationRoot = GLOBAL_CODEX_DIR;
      } else if (target === 'opendesign' || target === 'claude') {
        customizationRoot = GLOBAL_CLAUDE_DIR;
      } else {
        customizationRoot = path.join(workspacePath, '.agents');
      }

      const list = getSkillsInDir(customizationRoot);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        path: customizationRoot,
        skills: list
      }));
      return;
    }

    // 3. API - Install Skill
    if (req.url === '/api/install' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const params = JSON.parse(body);
          const targets = params.targets || [params.target || 'workspace'];
          const workspacePath = params.workspacePath || process.cwd();
          const source = params.source;
          
          if (!source) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Source is required.' }));
            return;
          }

          const installationPromises = targets.map(target => {
            let customizationRoot = '';
            if (target === 'global') {
              customizationRoot = GLOBAL_CONFIG_DIR;
            } else if (target === 'codex') {
              customizationRoot = GLOBAL_CODEX_DIR;
            } else if (target === 'opendesign' || target === 'claude') {
              customizationRoot = GLOBAL_CLAUDE_DIR;
            } else {
              customizationRoot = path.join(workspacePath, '.agents');
            }

            return installSkill(source, customizationRoot)
              .then(result => {
                // If it's opendesign or claude, also mirror it to .agents global folder
                if (target === 'opendesign' || target === 'claude') {
                  try {
                    const agentsSkillsDir = path.join(GLOBAL_AGENTS_DIR, 'skills');
                    if (!fs.existsSync(agentsSkillsDir)) {
                      fs.mkdirSync(agentsSkillsDir, { recursive: true });
                    }
                    const mirrorFolder = path.join(agentsSkillsDir, result.folderName);
                    if (fs.existsSync(mirrorFolder)) {
                      fs.rmSync(mirrorFolder, { recursive: true, force: true });
                    }
                    fs.cpSync(result.path, mirrorFolder, { recursive: true });
                    console.log(`Mirrored ${target} skill to: ${mirrorFolder}`);
                  } catch (mirrorErr) {
                    console.error('Failed to mirror skill to .agents:', mirrorErr);
                  }
                }
                return { success: true, target, result };
              })
              .catch(err => {
                return { success: false, target, error: err.message };
              });
          });

          Promise.all(installationPromises)
            .then(results => {
              const failed = results.filter(r => !r.success);
              if (failed.length === targets.length) {
                // All failed
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: results.map(r => `${r.target}: ${r.error}`).join('; ') }));
              } else {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, results, skill: results.find(r => r.success).result }));
              }
            });
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Invalid JSON payload' }));
        }
      });
      return;
    }

    // 4. API - Uninstall Skill
    if (req.url === '/api/uninstall' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const params = JSON.parse(body);
          const skillFolderPath = params.path;
          
          if (!skillFolderPath || !fs.existsSync(skillFolderPath)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Valid skill path is required.' }));
            return;
          }

          fs.rmSync(skillFolderPath, { recursive: true, force: true });

          // Mirror uninstall for Open Design (.claude & .agents)
          if (skillFolderPath.includes('.claude')) {
            const folderName = path.basename(skillFolderPath);
            const mirrorFolder = path.join(GLOBAL_AGENTS_DIR, 'skills', folderName);
            if (fs.existsSync(mirrorFolder)) {
              fs.rmSync(mirrorFolder, { recursive: true, force: true });
            }
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: e.message }));
        }
      });
      return;
    }

    // 5. API - Update Skill (Git Pull)
    if (req.url === '/api/update' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const params = JSON.parse(body);
          const skillFolderPath = params.path;

          if (!skillFolderPath || !fs.existsSync(skillFolderPath)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Valid skill path is required.' }));
            return;
          }

          if (!fs.existsSync(path.join(skillFolderPath, '.git'))) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Skill is not a Git repository.' }));
            return;
          }

          exec('git pull', { cwd: skillFolderPath }, (err, stdout, stderr) => {
            if (err) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, error: `Git pull failed: ${stderr || err.message}` }));
              return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, log: stdout }));
          });
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: e.message }));
        }
      });
      return;
    }

    // 6. API - Edit Skill File (SKILL.md)
    if (req.url === '/api/edit' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const params = JSON.parse(body);
          const skillFolderPath = params.path;
          const newContent = params.content;

          if (!skillFolderPath || !fs.existsSync(skillFolderPath)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Valid skill path is required.' }));
            return;
          }

          const skillMdPath = path.join(skillFolderPath, 'SKILL.md');
          fs.writeFileSync(skillMdPath, newContent, 'utf8');

          // Mirror edit for Open Design (.claude & .agents)
          if (skillFolderPath.includes('.claude')) {
            const folderName = path.basename(skillFolderPath);
            const mirrorFolder = path.join(GLOBAL_AGENTS_DIR, 'skills', folderName);
            if (fs.existsSync(mirrorFolder)) {
              fs.writeFileSync(path.join(mirrorFolder, 'SKILL.md'), newContent, 'utf8');
            }
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: e.message }));
        }
      });
      return;
    }

    // 7. Serving Static Files (HTML, CSS, JS)
    let reqUrl = req.url.split('?')[0]; // Strip search params
    let filePath = path.join(PUBLIC_DIR, reqUrl === '/' ? 'index.html' : reqUrl);
    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    // Prevent directory traversal attacks
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    fs.readFile(filePath, (err, content) => {
      if (err) {
        if (err.code === 'ENOENT') {
          res.writeHead(404);
          res.end('Not Found');
        } else {
          res.writeHead(500);
          res.end(`Server Error: ${err.code}`);
        }
      } else {
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content, 'utf-8');
      }
    });
  });

  // Try binding to port, find fallback if in use
  let port = PORT;
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      port++;
      console.log(`Port ${port - 1} in use, trying port ${port}...`);
      server.listen(port);
    } else {
      console.error('Server error:', e);
    }
  });

  server.listen(PORT, () => {
    const url = `http://localhost:${port}`;
    console.log(`========================================`);
    console.log(`Oneforall Skill Manager running at:`);
    console.log(`   \x1b[36m${url}\x1b[0m`);
    console.log(`========================================`);
    console.log(`Press Ctrl+C to terminate the server.`);

    // Automatically open browser on Windows
    exec(`cmd /c start ${url}`, (err) => {
      if (err) {
        console.log(`Could not automatically open browser: ${err.message}`);
        console.log(`Please visit ${url} manually.`);
      }
    });
  });
}

// Main logic routing
const args = process.argv.slice(2);
const isCliMode = args.includes('-i') || args.includes('--install') || args.includes('-l') || args.includes('--list') || args.includes('-h') || args.includes('--help');

if (isCliMode) {
  runCLI(args);
} else {
  startGUIServer();
}

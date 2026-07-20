<p align="center">
  <img src="public/oneforall-logo.png" alt="Oneforall Logo" width="140" height="140">
</p>

<h1 align="center">Oneforall Skill Manager</h1>

<p align="center">
  <strong>Universal Automated Skill Installer & Manager for AI Agents</strong><br>
  Seamlessly install, manage, edit, and distribute custom skills across <strong>Claude Code</strong>, <strong>Antigravity</strong>, <strong>Open Design</strong>, and <strong>Codex</strong>.
</p>

<p align="center">
  <a href="https://oneforall.ocloud.click"><img src="https://img.shields.io/badge/Website-oneforall.ocloud.click-ff3b46?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Website"></a>
  <a href="https://github.com/oneforall-dev"><img src="https://img.shields.io/badge/GitHub-oneforall--dev-181717?style=for-the-badge&logo=github&logoColor=white" alt="GitHub"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="License"></a>
  <img src="https://img.shields.io/badge/Node.js-v18%2B-green?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js">
</p>

---

## 📌 Table of Contents

- [ Overview](#-overview)
- [✨ Key Features](#-key-features)
- [📂 Supported AI Agent Platforms](#-supported-ai-agent-platforms)
- [🚀 Installation & Quick Start](#-installation--quick-start)
  - [Option A: Web Dashboard (Recommended)](#option-a-web-dashboard-recommended)
  - [Option B: Windows One-Click Script](#option-b-windows-one-click-script)
  - [Option C: Command Line Interface (CLI)](#option-c-command-line-interface-cli)
- [📖 Detailed Feature Walkthrough](#-detailed-feature-walkthrough)
  - [1. Smart Auto-Detection](#1-smart-auto-detection)
  - [2. Dual Selection Mode (Single vs Multi-Target)](#2-dual-selection-mode-single-vs-multi-target)
  - [3. Built-in SKILL.md Live Editor](#3-built-in-skillmd-live-editor)
  - [4. One-Click Cross-Platform Distribution](#4-one-click-cross-platform-distribution)
  - [5. Automatic Git Repository Sync](#5-automatic-git-repository-sync)
  - [6. Auto-Healing Directory Restructuring](#6-auto-healing-directory-restructuring)
  - [7. Productivity UX Shortcuts](#7-productivity-ux-shortcuts)
- [🔌 REST API Reference](#-rest-api-reference)
- [🏗️ Project Architecture](#️-project-architecture)
- [🔗 Links & Community](#-links--community)
- [📄 License](#-license)

---

## 🔍 Overview

**Oneforall Skill Manager** is a lightweight, zero-dependency Node.js application and web dashboard designed to manage AI agent skills (`SKILL.md` instruction sets). 

Managing custom skills manually across different AI tools often requires copying folders into hidden system directories (`~/.claude/skills`, `~/.gemini/config/skills`, `~/.codex/skills`, etc.). **Oneforall Skill Manager** automates this process into a single unified interface with 1-click installations, live code editing, and cross-platform synchronization.

---

## ✨ Key Features

- **🎯 Universal Multi-Agent Target Distribution**:
  Install skills directly into **Claude Code**, **Antigravity**, **Open Design**, and **Codex** without navigating file systems.
- **⚡ Smart Source Auto-Detection**:
  Intelligently parses Git repository URLs, direct GitHub file links (`/blob/main/.../SKILL.md`), `raw.githubusercontent.com` URLs, local `.md` file paths, or copy-pasted raw markdown text with YAML frontmatter.
- **🎛️ Dual Target Selection Mode**:
  Toggle between **Single Target Mode** (Radio behavior) and **Multi-Target Mode** (iOS-style switch) to deploy skills to all your AI agents simultaneously.
- **✏️ Integrated SKILL.md Live Editor**:
  Inspect, edit, and save skill instructions directly inside a syntax-highlighted modal with frontmatter parsing.
- **🔄 One-Click Distribution & Sync**:
  Distribute an already-installed skill to other agent platforms or update Git skills with 1-click `git pull`.
- **🩺 Auto-Healing Structure Engine**:
  Detects nested skill directories inside cloned repositories and restructures them into valid root skill folders automatically.
- **📋 Ergonomic UX**:
  Includes click-to-copy file paths, keyboard shortcuts (`Escape` to close modals, `Ctrl + Enter` to save), animated skeleton loading states, and toast notifications.

---

## 📂 Supported AI Agent Platforms

| Agent Target | Default Directory Path | Description |
| :--- | :--- | :--- |
| **Claude (Global)** | `~/.claude/skills` | Direct installation for **Claude Code CLI** |
| **Antigravity (Global)** | `~/.gemini/config/skills` | Custom skills directory for **Google Antigravity** |
| **Open Design (Global)** | `~/.claude/skills` & `~/.agents/skills` | Dual mirrored installation for **Open Design** agents |
| **Codex (Global)** | `~/.codex/skills` | Skills directory for **Codex** |

---

## 🚀 Installation & Quick Start

### Option A: Web Dashboard (Recommended)

1. **Clone the repository**:
   ```bash
   git clone https://github.com/oneforall-dev/oneforall-skill-manager.git
   cd oneforall-skill-manager
   ```

2. **Start the server**:
   ```bash
   npm start
   # or
   node installer.js
   ```

3. **Open the Dashboard**:
   Navigate to 👉 **`http://localhost:3000`** in your browser.

---

### Option B: Windows One-Click Script

Double-click `start-portal.cmd` in the project root. This automatically starts the background Node.js server and launches `http://localhost:3000` in your default browser.

---

### Option C: Command Line Interface (CLI)

Install a skill directly from the terminal:

```bash
# Install from a Git Repository URL
node installer.js -i "https://github.com/user/my-skill-repo.git"

# Install from a direct GitHub file link
node installer.js -i "https://github.com/anthropics/claude-code/blob/main/plugins/frontend-design/skills/frontend-design/SKILL.md"

# Install from a local file path
node installer.js -i "C:\path\to\my-skill\SKILL.md"
```

---

## 📖 Detailed Feature Walkthrough

### 1. Smart Auto-Detection
Paste any of the following into the install text area:
- **Git Repository URL**: `https://github.com/user/skill-name.git`
- **GitHub File Blob URL**: `https://github.com/user/repo/blob/main/skills/my-skill/SKILL.md`
- **Raw GitHub Link**: `https://raw.githubusercontent.com/user/repo/main/SKILL.md`
- **Local File Path**: `C:\Users\name\my-skill\SKILL.md`
- **Raw Markdown**: Copy-pasted text beginning with `---\nname: my-skill\n---`

The application detects the format in real-time, displays a preview badge, and prepares the installation payload automatically.

---

### 2. Dual Selection Mode (Single vs Multi-Target)
- **Single Mode (Default)**: Clicking a target (e.g. `Claude`) selects it exclusively.
- **Seleccionar Varios (Toggle Switch)**: Flip the iOS-style toggle to enable multi-target selection, allowing you to check `Claude`, `Antigravity`, `Open Design`, and `Codex` at the same time.

---

### 3. Built-in SKILL.md Live Editor
Click **Edit** on any installed skill card to open the live editor modal. Modify YAML metadata or instruction prompts directly and press `Ctrl + Enter` to save.

---

### 4. One-Click Cross-Platform Distribution
Click **Distribute** on any skill card. The modal checks all 4 agent platforms, shows where the skill is currently installed vs missing, and allows you to copy it to missing targets with 1 click.

---

### 5. Automatic Git Repository Sync
Skills installed from Git repositories display a green **Git Repo** badge. Click **Update** to execute an automated `git pull` in the background and keep your skill up to date.

---

### 6. Auto-Healing Directory Restructuring
When cloning repositories that contain nested folders or non-standard structures, the Auto-Healing engine scans subdirectories for `SKILL.md`, moves the content to the skill root, and cleans up nested `.git` folders.

---

### 7. Productivity UX Shortcuts
- **Click-to-Copy Path**: Click on any printed file path (`C:\Users\...`) to copy it to your clipboard.
- **Escape Key**: Instantly closes active modals.
- **Ctrl / Cmd + Enter**: Saves content inside the SKILL.md live editor.

---

## 🔌 REST API Reference

The Node.js server provides lightweight JSON REST endpoints:

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/detect-workspace` | Returns local workspace & global config paths |
| `GET` | `/api/skills?target=claude` | Lists all installed skills in specified target |
| `POST` | `/api/install` | Installs skill from URL/file/text to selected targets |
| `POST` | `/api/check-installations` | Checks skill installation status across all targets |
| `POST` | `/api/distribute` | Copies a skill from one target to selected targets |
| `POST` | `/api/edit` | Updates `SKILL.md` file contents |
| `POST` | `/api/delete` | Uninstalls a skill from target directory |
| `POST` | `/api/git-pull` | Executes `git pull` on a Git-backed skill |

---

## 🏗️ Project Architecture

```
oneforall-skill-manager/
├── installer.js            # Node.js Backend Server & CLI Engine
├── package.json            # NPM Package Descriptor
├── README.md               # Documentation
├── start-portal.cmd        # Windows Launcher Script
└── public/                 # Web Dashboard Frontend
    ├── index.html          # Dashboard HTML Structure
    ├── style.css           # Glassmorphism Red-Neon CSS System
    ├── app.js              # Client Application Logic
    └── oneforall-logo.png  # Official Oneforall Branding Logo
```

---

## 🔗 Links & Community

- **Official Website**: [https://oneforall.ocloud.click](https://oneforall.ocloud.click)
- **GitHub Organization**: [https://github.com/oneforall-dev](https://github.com/oneforall-dev)

---

## 📄 License

Distributed under the **MIT License**. See `LICENSE` for details.

// Antigravity Skill Portal Client Application Logic

document.addEventListener('DOMContentLoaded', () => {
  // Elements
  const pasteInput = document.getElementById('paste-input');
  const clearBtn = document.getElementById('clear-btn');
  const detectorPanel = document.getElementById('detector-panel');
  const detectorText = document.getElementById('detector-text');
  const previewCard = document.getElementById('preview-card');
  const previewType = document.getElementById('preview-type');
  const previewName = document.getElementById('preview-name');
  const previewDesc = document.getElementById('preview-desc');
  
  const targetGlobal = document.getElementById('target-global');
  const targetWorkspace = document.getElementById('target-workspace');
  const workspacePathContainer = document.getElementById('workspace-path-container');
  const workspacePathInput = document.getElementById('workspace-path-input');
  const resolvedSkillsPath = document.getElementById('resolved-skills-path');
  const resetPathBtn = document.getElementById('reset-path-btn');
  
  const installBtn = document.getElementById('install-btn');
  const installBtnText = document.getElementById('install-btn-text');
  const btnSpinner = installBtn.querySelector('.btn-spinner');
  const allowMultiTargets = document.getElementById('allow-multi-targets');
  
  const tabButtons = document.querySelectorAll('.tab-btn');
  const skillsSearch = document.getElementById('skills-search');
  const skillsList = document.getElementById('skills-list');
  
  // Editor Modal Elements
  const editorModal = document.getElementById('editor-modal');
  const modalSkillName = document.getElementById('modal-skill-name');
  const modalEditor = document.getElementById('modal-editor');
  const modalCancelBtn = document.getElementById('modal-cancel-btn');
  const modalSaveBtn = document.getElementById('modal-save-btn');
  const closeModalBtn = document.getElementById('close-modal-btn');

  // Distribution Modal Elements
  const distModal = document.getElementById('dist-modal');
  const distModalSkillName = document.getElementById('dist-modal-skill-name');
  const distModalCurrentPath = document.getElementById('dist-modal-current-path');
  const distTargetsList = document.getElementById('dist-targets-list');
  const closeDistModalBtn = document.getElementById('close-dist-modal-btn');
  const distModalCancelBtn = document.getElementById('dist-modal-cancel-btn');
  const distModalSubmitBtn = document.getElementById('dist-modal-submit-btn');
  
  // State
  let defaultWorkspacePath = '';
  let globalConfigDir = '';
  let activeTab = 'claude'; // 'claude', 'global', 'opendesign', 'codex'
  let installedSkillsList = [];
  let detectedType = null; // 'git', 'raw', 'url', 'file', null
  let activeEditingSkillPath = null;
  let activeDistributingSkill = null;

  // Initialize
  init();

  async function init() {
    setupEventListeners();
    await detectWorkspace();
    loadInstalledSkills();
  }

  // Event listeners registry
  function setupEventListeners() {
    // Paste area live handling
    pasteInput.addEventListener('input', handlePasteInput);
    clearBtn.addEventListener('click', () => {
      pasteInput.value = '';
      handlePasteInput();
    });

    // Destination target toggles
    document.querySelectorAll('.target-dest-checkbox').forEach(checkbox => {
      checkbox.addEventListener('change', handleTargetChange);
    });

    if (allowMultiTargets) {
      allowMultiTargets.addEventListener('change', () => {
        if (!allowMultiTargets.checked) {
          const checked = Array.from(document.querySelectorAll('.target-dest-checkbox:checked'));
          if (checked.length > 1) {
            checked.forEach(cb => {
              cb.checked = (cb.value === activeTab);
            });
            if (document.querySelectorAll('.target-dest-checkbox:checked').length === 0 && checked[0]) {
              checked[0].checked = true;
            }
          }
        }
      });
    }
    
    // Path update input
    workspacePathInput.addEventListener('input', () => {
      resolvedSkillsPath.textContent = `${workspacePathInput.value || '...'}\\.agents\\skills\\`;
      if (activeTab === 'workspace') {
        loadInstalledSkills();
      }
    });
    
    resetPathBtn.addEventListener('click', () => {
      workspacePathInput.value = defaultWorkspacePath;
      resolvedSkillsPath.textContent = `${defaultWorkspacePath}\\.agents\\skills\\`;
      if (activeTab === 'workspace') {
        loadInstalledSkills();
      }
    });

    // Install Action
    installBtn.addEventListener('click', handleInstallAction);

    // Tab Filters
    tabButtons.forEach(btn => {
      btn.addEventListener('click', (e) => {
        tabButtons.forEach(b => b.classList.remove('active'));
        e.currentTarget.classList.add('active');
        activeTab = e.currentTarget.dataset.tab;
        loadInstalledSkills();
      });
    });

    // Search input
    skillsSearch.addEventListener('input', filterSkills);

    // Modal events
    closeModalBtn.addEventListener('click', hideEditorModal);
    modalCancelBtn.addEventListener('click', hideEditorModal);
    modalSaveBtn.addEventListener('click', saveSkillEdits);

    // Distribution Modal events
    closeDistModalBtn.addEventListener('click', hideDistModal);
    distModalCancelBtn.addEventListener('click', hideDistModal);
    distModalSubmitBtn.addEventListener('click', submitDistribution);

    // Keyboard Shortcuts (Escape to close modals, Ctrl+Enter to save edits)
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!editorModal.classList.contains('hidden')) hideEditorModal();
        if (!distModal.classList.contains('hidden')) hideDistModal();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        if (!editorModal.classList.contains('hidden')) {
          e.preventDefault();
          saveSkillEdits();
        }
      }
    });
  }

  // Get active workspace directory from backend API
  async function detectWorkspace() {
    try {
      const res = await fetch('/api/detect-workspace');
      const data = await res.json();
      defaultWorkspacePath = data.defaultWorkspace;
      globalConfigDir = data.globalConfigDir;
      
      workspacePathInput.value = defaultWorkspacePath;
      resolvedSkillsPath.textContent = `${defaultWorkspacePath}\\.agents\\skills\\`;
    } catch (err) {
      console.error('Error detecting workspace:', err);
      showToast('Error communicating with backend server', 'error');
    }
  }

  // Live Auto-Detection logic
  function handlePasteInput() {
    const rawVal = pasteInput.value.trim();

    if (!rawVal) {
      // Clear states
      detectorPanel.classList.add('hidden');
      previewCard.classList.add('hidden');
      installBtn.disabled = true;
      detectorPanel.className = 'detector-panel hidden';
      detectedType = null;
      return;
    }

    detectorPanel.classList.remove('hidden');
    installBtn.disabled = false;

    // 1. Git Repository detection
    const isGit = rawVal.startsWith('http') && (rawVal.endsWith('.git') || rawVal.includes('github.com/') || rawVal.includes('gitlab.com/'));
    
    // 2. Remote markdown URL
    const isUrl = rawVal.startsWith('http') && (rawVal.endsWith('.md') || rawVal.includes('/raw/'));
    
    // 3. Raw YAML block detection
    const isRaw = rawVal.startsWith('---') && rawVal.includes('name:') && rawVal.includes('description:');
    
    // 4. File Path detection (Windows drive letter or relative file paths)
    const isFile = /^[a-zA-Z]:\\/i.test(rawVal) && rawVal.endsWith('.md');

    if (isGit) {
      detectedType = 'git';
      detectorPanel.className = 'detector-panel active-git';
      detectorText.textContent = 'Git Repository URL Detected';
      
      // Try to parse repo name
      let repoName = rawVal.split('/').pop().replace(/\.git$/, '');
      showPreview('Git Repository', repoName, `Will clone entire repository from ${rawVal}`);
    } 
    else if (isUrl) {
      detectedType = 'url';
      detectorPanel.className = 'detector-panel active-url';
      detectorText.textContent = 'Remote SKILL.md Link Detected';
      
      let fileName = rawVal.split('/').pop();
      showPreview('Remote MD Link', fileName, `Will download file content from ${rawVal}`);
    } 
    else if (isRaw) {
      detectedType = 'raw';
      detectorPanel.className = 'detector-panel active-raw';
      detectorText.textContent = 'Raw SKILL.md Content Detected';
      
      // Parse YAML frontmatter
      const meta = parseFrontmatter(rawVal);
      showPreview('Raw Markdown', meta.name || 'Untitled Skill', meta.description || 'Pasted content');
    }
    else if (isFile) {
      detectedType = 'file';
      detectorPanel.className = 'detector-panel active-raw';
      detectorText.textContent = 'Local MD File Path Detected';
      
      let baseName = rawVal.split('\\').pop();
      showPreview('Local File', baseName, `Will copy markdown content from local path: ${rawVal}`);
    }
    else {
      detectedType = null;
      detectorPanel.className = 'detector-panel';
      detectorText.textContent = 'Unrecognized input format';
      previewCard.classList.add('hidden');
      installBtn.disabled = true;
    }
  }

  // Frontmatter helper matching backend regex
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

  function showPreview(type, name, desc) {
    previewCard.classList.remove('hidden');
    previewType.textContent = type;
    previewName.textContent = name;
    previewDesc.textContent = desc;
  }

  // Destination directory layout updates
  function handleTargetChange(e) {
    const isMulti = allowMultiTargets ? allowMultiTargets.checked : false;
    const clickedBox = e ? e.target : null;

    if (!isMulti && clickedBox && clickedBox.classList && clickedBox.classList.contains('target-dest-checkbox')) {
      if (clickedBox.checked) {
        document.querySelectorAll('.target-dest-checkbox').forEach(cb => {
          if (cb !== clickedBox) cb.checked = false;
        });
      } else {
        clickedBox.checked = true;
      }
    }

    const workspaceEl = document.getElementById('target-workspace');
    const workspaceChecked = workspaceEl ? workspaceEl.checked : false;
    if (workspaceChecked) {
      workspacePathContainer.classList.remove('hidden');
    } else {
      workspacePathContainer.classList.add('hidden');
    }

    // Auto-switch right dashboard tab to match the target they just checked (if any)
    const checkedBoxes = Array.from(document.querySelectorAll('.target-dest-checkbox:checked')).map(cb => cb.value);
    if (checkedBoxes.length > 0) {
      const activeTarget = checkedBoxes[checkedBoxes.length - 1];
      tabButtons.forEach(btn => {
        if (btn.dataset.tab === activeTarget) {
          tabButtons.forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          activeTab = activeTarget;
        }
      });
    }

    loadInstalledSkills();
  }

  // Load Installed Skills from target path
  async function loadInstalledSkills() {
    const target = activeTab;
    const workspacePath = workspacePathInput.value;

    skillsList.innerHTML = `
      <div class="loading-state">
        <div class="spinner"></div>
        <span>Fetching skills...</span>
      </div>
    `;

    try {
      const url = `/api/skills?target=${target}&workspacePath=${encodeURIComponent(workspacePath)}`;
      const res = await fetch(url);
      const data = await res.json();

      if (!data.success) {
        showEmptyState(data.error || 'Failed to retrieve skills directory.');
        return;
      }

      installedSkillsList = data.skills;
      renderSkills(installedSkillsList);
    } catch (err) {
      console.error(err);
      showEmptyState('Could not connect to backend server. Make sure installer.js server is running.');
    }
  }

  function showEmptyState(msg) {
    skillsList.innerHTML = `
      <div class="empty-state">
        <span class="material-symbols-outlined">folder_off</span>
        <span>${msg}</span>
      </div>
    `;
  }

  // Render Skill card elements inside container
  function renderSkills(skills) {
    if (!skills || skills.length === 0) {
      skillsList.innerHTML = `
        <div class="empty-state">
          <span class="material-symbols-outlined">folder_open</span>
          <span>No skills installed in this folder yet.</span>
        </div>
      `;
      return;
    }

    skillsList.innerHTML = '';
    skills.forEach(skill => {
      const card = document.createElement('div');
      card.className = 'skill-card';
      
      const titleText = skill.name === skill.folderName ? skill.name : `${skill.name}`;
      const badgeClass = skill.isGit ? 'git' : '';
      const badgeLabel = skill.isGit ? 'Git Repo' : 'Direct Skill';

      card.innerHTML = `
        <div class="skill-meta">
          <div class="skill-name-wrapper">
            <span class="skill-title">${escapeHTML(titleText)}</span>
            <span class="skill-folder">${escapeHTML(skill.folderName)}</span>
          </div>
          <span class="type-tag ${badgeClass}">${badgeLabel}</span>
        </div>
        <div class="skill-description">${escapeHTML(skill.description)}</div>
        <div class="skill-actions">
          <span class="skill-path" title="${escapeHTML(skill.path)}">${escapeHTML(skill.path)}</span>
          <div class="skill-buttons">
            ${skill.isGit ? `
              <button class="action-btn btn-update tooltip" data-tooltip="Git pull update">
                <span class="material-symbols-outlined">sync</span>
                <span>Update</span>
              </button>
            ` : ''}
            <button class="action-btn btn-dist tooltip" data-tooltip="Distribute to other apps">
              <span class="material-symbols-outlined">share</span>
              <span>Distribute</span>
            </button>
            <button class="action-btn btn-edit tooltip" data-tooltip="Edit file">
              <span class="material-symbols-outlined">edit</span>
              <span>Edit</span>
            </button>
            <button class="action-btn btn-delete tooltip" data-tooltip="Uninstall skill">
              <span class="material-symbols-outlined">delete</span>
              <span>Delete</span>
            </button>
          </div>
        </div>
      `;

      // Set event bindings on buttons
      if (skill.isGit) {
        card.querySelector('.btn-update').addEventListener('click', () => updateSkill(skill));
      }
      card.querySelector('.btn-dist').addEventListener('click', () => openDistModal(skill));
      card.querySelector('.btn-edit').addEventListener('click', () => openEditorModal(skill));
      card.querySelector('.btn-delete').addEventListener('click', () => uninstallSkill(skill));

      // Click to copy skill path
      const pathEl = card.querySelector('.skill-path');
      pathEl.style.cursor = 'pointer';
      pathEl.addEventListener('click', () => {
        navigator.clipboard.writeText(skill.path).then(() => {
          showToast('Ruta copiada al portapapeles', 'success');
        }).catch(() => {
          showToast('Error al copiar la ruta', 'error');
        });
      });

      skillsList.appendChild(card);
    });
  }

  // Filter skills list inside search input
  function filterSkills() {
    const q = skillsSearch.value.toLowerCase().trim();
    if (!q) {
      renderSkills(installedSkillsList);
      return;
    }

    const filtered = installedSkillsList.filter(s => 
      s.name.toLowerCase().includes(q) || 
      s.folderName.toLowerCase().includes(q) || 
      s.description.toLowerCase().includes(q)
    );

    if (filtered.length === 0) {
      skillsList.innerHTML = `
        <div class="empty-state">
          <span class="material-symbols-outlined">search_off</span>
          <span>No skills found matching "${escapeHTML(q)}"</span>
        </div>
      `;
      return;
    }

    renderSkills(filtered);
  }

  // Install Skill Backend trigger
  async function handleInstallAction() {
    const sourceVal = pasteInput.value.trim();
    const checkedBoxes = Array.from(document.querySelectorAll('.target-dest-checkbox:checked')).map(cb => cb.value);
    const workspacePath = workspacePathInput.value;

    if (!sourceVal) return;
    if (checkedBoxes.length === 0) {
      showToast('Please select at least one installation target.', 'error');
      return;
    }

    // Show loading
    setInstallLoading(true);

    try {
      const res = await fetch('/api/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: sourceVal,
          targets: checkedBoxes,
          workspacePath
        })
      });

      const data = await res.json();

      if (data.success) {
        showToast(`Successfully installed: ${data.skill.name}!`, 'success');
        pasteInput.value = '';
        handlePasteInput();
        loadInstalledSkills();
      } else {
        showToast(data.error || 'Failed to install skill.', 'error');
      }
    } catch (err) {
      console.error(err);
      showToast('Connection to installer server lost.', 'error');
    } finally {
      setInstallLoading(false);
    }
  }

  // Uninstall Skill Trigger
  async function uninstallSkill(skill) {
    if (!confirm(`Are you sure you want to completely delete "${skill.name}"? This removes its folder permanently.`)) {
      return;
    }

    try {
      const res = await fetch('/api/uninstall', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: skill.path })
      });
      const data = await res.json();

      if (data.success) {
        showToast(`Deleted skill folder: ${skill.folderName}`, 'success');
        loadInstalledSkills();
      } else {
        showToast(data.error || 'Failed to delete folder.', 'error');
      }
    } catch (err) {
      console.error(err);
      showToast('Error sending uninstall request.', 'error');
    }
  }

  // Git Update Pull trigger
  async function updateSkill(skill) {
    showToast(`Checking updates for ${skill.name}...`, 'info');
    
    try {
      const res = await fetch('/api/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: skill.path })
      });
      const data = await res.json();

      if (data.success) {
        showToast(`${skill.name} updated: ${data.log || 'Already up to date.'}`, 'success');
        loadInstalledSkills();
      } else {
        showToast(data.error || 'Git update failed.', 'error');
      }
    } catch (err) {
      console.error(err);
      showToast('Git command execution timed out or failed.', 'error');
    }
  }

  // Open Edit Dialog
  function openEditorModal(skill) {
    activeEditingSkillPath = skill.path;
    modalSkillName.textContent = skill.name;
    modalEditor.value = skill.content || '';
    editorModal.classList.remove('hidden');
  }

  function hideEditorModal() {
    editorModal.classList.add('hidden');
    activeEditingSkillPath = null;
  }

  // Save changes to SKILL.md
  async function saveSkillEdits() {
    if (!activeEditingSkillPath) return;

    const newContent = modalEditor.value;

    setSaveLoading(true);

    try {
      const res = await fetch('/api/edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: activeEditingSkillPath,
          content: newContent
        })
      });
      const data = await res.json();

      if (data.success) {
        showToast('SKILL.md saved successfully!', 'success');
        hideEditorModal();
        loadInstalledSkills();
      } else {
        showToast(data.error || 'Failed to write edits.', 'error');
      }
    } catch (err) {
      console.error(err);
      showToast('Failed to save file updates.', 'error');
    } finally {
      setSaveLoading(false);
    }
  }

  // Distribution modal handling
  async function openDistModal(skill) {
    activeDistributingSkill = skill;
    distModalSkillName.textContent = skill.name;
    distModalCurrentPath.textContent = skill.path;
    distModalSubmitBtn.disabled = true;

    // Reset list with spinner
    distTargetsList.innerHTML = `
      <div class="loading-state">
        <div class="spinner"></div>
        <span>Checking installations across platforms...</span>
      </div>
    `;

    distModal.classList.remove('hidden');

    try {
      const workspacePath = workspacePathInput.value;
      const url = `/api/check-installations?folderName=${encodeURIComponent(skill.folderName)}&workspacePath=${encodeURIComponent(workspacePath)}`;
      const res = await fetch(url);
      const data = await res.json();

      if (!data.success) {
        distTargetsList.innerHTML = `<div class="error-text">${escapeHTML(data.error || 'Failed to check target environments.')}</div>`;
        return;
      }

      const targets = [
        { key: 'claude', label: 'Claude (Global)', path: data.installations.claude ? data.installations.claude.path : '', installed: data.installations.claude ? data.installations.claude.installed : false },
        { key: 'global', label: 'Antigravity (Global)', path: data.installations.global ? data.installations.global.path : '', installed: data.installations.global ? data.installations.global.installed : false },
        { key: 'opendesign', label: 'Open Design (Global)', path: data.installations.opendesign ? data.installations.opendesign.path : '', installed: data.installations.opendesign ? data.installations.opendesign.installed : false },
        { key: 'codex', label: 'Codex (Global)', path: data.installations.codex ? data.installations.codex.path : '', installed: data.installations.codex ? data.installations.codex.installed : false }
      ];

      distTargetsList.innerHTML = '';
      targets.forEach(t => {
        const row = document.createElement('div');
        row.className = 'dist-target-row';
        
        row.innerHTML = `
          <div class="dist-target-info">
            <div class="dist-target-name">${escapeHTML(t.label)}</div>
            <div class="dist-target-path" title="${escapeHTML(t.path)}">${escapeHTML(t.path)}</div>
          </div>
          <div class="dist-target-actions">
            ${t.installed ? 
              `<span class="badge-installed">Installed</span>` : 
              `<span class="badge-missing">Missing</span>
               <input type="checkbox" class="dist-target-checkbox" value="${t.key}">`
            }
          </div>
        `;
        
        distTargetsList.appendChild(row);
      });

      // Bind changes on checkboxes to enable / disable submit button
      const checkboxes = distTargetsList.querySelectorAll('.dist-target-checkbox');
      checkboxes.forEach(cb => {
        cb.addEventListener('change', () => {
          const anyChecked = Array.from(checkboxes).some(c => c.checked);
          distModalSubmitBtn.disabled = !anyChecked;
        });
      });

    } catch (err) {
      console.error(err);
      distTargetsList.innerHTML = `<div class="error-text">Network error checking targets.</div>`;
    }
  }

  function hideDistModal() {
    distModal.classList.add('hidden');
    activeDistributingSkill = null;
  }

  async function submitDistribution() {
    if (!activeDistributingSkill) return;

    const checkedTargets = Array.from(distTargetsList.querySelectorAll('.dist-target-checkbox:checked')).map(cb => cb.value);
    if (checkedTargets.length === 0) return;

    // Show loading on button
    const submitBtnText = distModalSubmitBtn.querySelector('span');
    const spinner = distModalSubmitBtn.querySelector('.btn-spinner');
    distModalSubmitBtn.disabled = true;
    spinner.classList.remove('hidden');
    submitBtnText.textContent = 'Copying...';

    try {
      const workspacePath = workspacePathInput.value;
      const res = await fetch('/api/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: activeDistributingSkill.path, // Source is the current folder path!
          targets: checkedTargets,
          workspacePath
        })
      });

      const data = await res.json();

      if (data.success) {
        showToast(`Skill successfully distributed to selected targets!`, 'success');
        hideDistModal();
        loadInstalledSkills();
      } else {
        showToast(data.error || 'Failed to distribute skill.', 'error');
      }
    } catch (err) {
      console.error(err);
      showToast('Connection to server lost while distributing.', 'error');
    } finally {
      spinner.classList.add('hidden');
      submitBtnText.textContent = 'Copy to Selected';
      // Enable it back if they check again
      const checkboxes = distTargetsList.querySelectorAll('.dist-target-checkbox');
      const anyChecked = Array.from(checkboxes).some(c => c.checked);
      distModalSubmitBtn.disabled = !anyChecked;
    }
  }

  // UI state toggles for loading
  function setInstallLoading(isLoading) {
    if (isLoading) {
      installBtn.disabled = true;
      btnSpinner.classList.remove('hidden');
      installBtnText.textContent = 'Installing...';
    } else {
      installBtn.disabled = false;
      btnSpinner.classList.add('hidden');
      installBtnText.textContent = 'Install Skill';
    }
  }

  function setSaveLoading(isLoading) {
    if (isLoading) {
      modalSaveBtn.disabled = true;
      modalSaveBtn.querySelector('.btn-spinner').classList.remove('hidden');
    } else {
      modalSaveBtn.disabled = false;
      modalSaveBtn.querySelector('.btn-spinner').classList.add('hidden');
    }
  }

  // Floating Notification Toast System
  function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    let icon = 'info';
    if (type === 'success') icon = 'check_circle';
    if (type === 'error') icon = 'error';

    toast.innerHTML = `
      <span class="material-symbols-outlined">${icon}</span>
      <span>${escapeHTML(message)}</span>
    `;

    container.appendChild(toast);

    // Auto-remove toast after 4.5 seconds
    setTimeout(() => {
      toast.style.transform = 'translateX(120%)';
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }, 4500);
  }

  // Helper to escape HTML characters
  function escapeHTML(str) {
    if (typeof str !== 'string') return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
});

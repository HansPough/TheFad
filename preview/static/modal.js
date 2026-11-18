/* Preview only: destructive buttons confirm once, then post — no approval PIN dialog. */
(function () {
  const dialog = document.getElementById('approval-modal');
  if (!dialog) return;
  const form = document.getElementById('approval-form');

  document.querySelectorAll('[data-confirm]').forEach(function (button) {
    button.addEventListener('click', function () {
      if (!confirm(button.dataset.message || button.dataset.title || 'Continue?')) return;
      form.setAttribute('action', button.dataset.action);
      form.querySelectorAll('[data-preview-extra]').forEach(function (input) { input.remove(); });
      let fields = {};
      try { fields = JSON.parse(button.dataset.fields || '{}'); } catch (error) { fields = {}; }
      Object.keys(fields).forEach(function (name) {
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = name;
        input.value = fields[name];
        input.dataset.previewExtra = '1';
        form.append(input);
      });
      form.submit();
    });
  });
})();

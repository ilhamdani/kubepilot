// Small progressive-enhancement layer: reveal on scroll, copy-to-clipboard.
(() => {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Reveal sections as they enter the viewport.
  const targets = document.querySelectorAll('[data-reveal]');
  if (targets.length && !reduce && 'IntersectionObserver' in window) {
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-in');
            io.unobserve(entry.target);
          }
        }
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
    );
    targets.forEach((el) => io.observe(el));
  } else {
    targets.forEach((el) => el.classList.add('is-in'));
  }

  // Copy buttons next to install commands.
  document.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const text = btn.getAttribute('data-copy') ?? '';
      try {
        await navigator.clipboard.writeText(text);
        const previous = btn.textContent;
        btn.textContent = 'copied';
        setTimeout(() => {
          btn.textContent = previous;
        }, 1400);
      } catch {
        btn.textContent = 'ctrl+c';
      }
    });
  });
})();

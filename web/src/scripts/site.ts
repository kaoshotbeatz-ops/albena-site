// Shared behaviour: js flag, mobile nav, reveal-on-scroll, nav border.
const root = document.documentElement;
root.classList.add('js');

const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// reveal
const els = document.querySelectorAll<HTMLElement>('.reveal');
if (reduce || !('IntersectionObserver' in window)) {
  els.forEach((e) => e.classList.add('in'));
} else {
  const io = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (en.isIntersecting) {
          en.target.classList.add('in');
          io.unobserve(en.target);
        }
      }
    },
    { threshold: 0.08, rootMargin: '0px 0px -4% 0px' },
  );
  els.forEach((e) => io.observe(e));
}

// nav
const nav = document.querySelector<HTMLElement>('[data-nav]');
const onScroll = () => nav?.classList.toggle('scrolled', window.scrollY > 8);
window.addEventListener('scroll', onScroll, { passive: true });
onScroll();

const toggle = document.querySelector<HTMLButtonElement>('[data-nav-toggle]');
const panel = document.getElementById('nav-panel');
if (toggle && panel) {
  const set = (open: boolean) => {
    panel.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));
  };
  toggle.addEventListener('click', () => set(!panel.classList.contains('open')));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panel.classList.contains('open')) { set(false); toggle.focus(); }
  });
  panel.addEventListener('click', (e) => { if ((e.target as HTMLElement).closest('a')) set(false); });
}

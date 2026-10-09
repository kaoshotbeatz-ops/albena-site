(function () {
  // Scroll reveal
  var els = document.querySelectorAll('.reveal');
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce || !('IntersectionObserver' in window)) {
    els.forEach(function (e) { e.classList.add('in'); });
  } else {
    document.documentElement.classList.add('js');
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
      });
    }, { threshold: 0.12 });
    els.forEach(function (e) { io.observe(e); });
  }

  // Waitlist
  var form = document.getElementById('waitlist-form');
  var msg = document.getElementById('form-msg');
  var thanks = document.getElementById('thanks');
  var input = document.getElementById('email');
  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var v = input.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
      msg.textContent = 'Please enter a valid email address.';
      input.setAttribute('aria-invalid', 'true');
      input.focus();
      return;
    }
    input.removeAttribute('aria-invalid');
    msg.textContent = '';
    var subject = encodeURIComponent('Albena waitlist');
    var body = encodeURIComponent('Please add me to the Albena waitlist: ' + v);
    window.location.href = 'mailto:hello@albena.ai?subject=' + subject + '&body=' + body;
    form.hidden = true;
    thanks.hidden = false;
    thanks.focus();
  });
})();

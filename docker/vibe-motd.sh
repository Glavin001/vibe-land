# Printed on every interactive login. The point is that someone who SSHes in
# knowing nothing finds the one command they need without having to ask.
# Deliberately short: a long banner gets scrolled past and ignored.
case $- in *i*) ;; *) return ;; esac
printf '\n\033[1;36m  vibe-land dev box\033[0m  — CUDA + PhysX + Blast + Rust + Node, no source yet\n\n'
if [ -d /root/vibe-land ]; then
  printf '    \033[1mvibe-up\033[0m            build and run (re-run for an undamaged city)\n'
  printf '    vibe-up --status   is it running, and how did the last one die\n'
else
  printf '    \033[1mvibe-up\033[0m            clone, build and run — start here\n'
fi
printf '    cat ~/README.md    ports, health checks, and the traps\n\n'

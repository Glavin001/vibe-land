# Printed on every interactive login. The point is that someone who SSHes in
# knowing nothing finds the one command they need without having to ask.
# Deliberately short: a long banner gets scrolled past and ignored.
case $- in *i*) ;; *) return ;; esac
printf '\n\033[1;36m  vibe-land dev box\033[0m  — CUDA + PhysX + Blast + Rust + Node\n\n'

# If the box was created with --onstart-cmd 'vibe-autostart', it has been
# building since boot. Say so: landing on a machine at 100% CPU with no
# explanation is worse than waiting for a build you know about.
_vibe_state="$(cat /root/.vibe-boot-state 2>/dev/null || true)"
case "$_vibe_state" in
  building)
    printf '    \033[1;33mbuilding since boot\033[0m — tail -f /root/vibe-boot.log\n'
    printf '    Started automatically at boot. It will be ready shortly.\n\n' ;;
  ready)
    printf '    \033[1;32mready\033[0m — built and running. vibe-up --status\n'
    printf '    tail -f /tmp/city-physx-server.log     the server\n\n' ;;
  failed)
    printf '    \033[1;31mthe boot build FAILED\033[0m — cat /root/vibe-boot.log\n'
    printf '    Fix it, then: vibe-up\n\n' ;;
  *)
    if [ -d /root/vibe-land ]; then
      printf '    \033[1mvibe-up\033[0m            build and run (re-run for an undamaged city)\n'
      printf '    vibe-up --status   is it running, and how did the last one die\n'
    else
      printf '    \033[1mvibe-up\033[0m            clone, build and run — start here\n'
    fi
    printf '    cat ~/README.md    ports, health checks, and the traps\n\n' ;;
esac
unset _vibe_state

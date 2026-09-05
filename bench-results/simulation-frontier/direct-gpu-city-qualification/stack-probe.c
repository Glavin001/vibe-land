#define _GNU_SOURCE
#include <execinfo.h>
#include <signal.h>
#include <unistd.h>
static void snapshot(int sig) {
  (void)sig;
  void *frames[80];
  static const char start[]="\nDIRECT_GPU_TEST_STACK_BEGIN\n";
  static const char end[]="DIRECT_GPU_TEST_STACK_END\n";
  write(STDERR_FILENO,start,sizeof(start)-1);
  int n=backtrace(frames,80);
  backtrace_symbols_fd(frames,n,STDERR_FILENO);
  write(STDERR_FILENO,end,sizeof(end)-1);
}
__attribute__((constructor)) static void install(void) {
  void *frames[1]; backtrace(frames,1);
  struct sigaction sa={0};
  sa.sa_handler=snapshot; sa.sa_flags=SA_RESTART;
  sigemptyset(&sa.sa_mask); sigaction(SIGUSR2,&sa,0);
}

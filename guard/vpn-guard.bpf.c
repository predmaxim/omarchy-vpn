// predmaxim.vpn, programs only through VPN: tag a task when it execs a listed file (script or
// binary), children inherit the tag, sockets of tagged tasks (or of a listed exe) get VPN_MARK;
// nftables (vpn-guard) lets marked sockets out through TUN only. Nothing here denies anything.
// Design: omarchy-dotfiles docs/superpowers/specs/2026-11-10-vpn-only-apps-design.md
#include <linux/bpf.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>
#include <bpf/bpf_core_read.h>

#define NAME_LEN 64
#define VPN_MARK 0x10000000

struct qstr { const unsigned char *name; } __attribute__((preserve_access_index));
struct dentry { struct qstr d_name; } __attribute__((preserve_access_index));
struct path { struct dentry *dentry; } __attribute__((preserve_access_index));
struct file { struct path f_path; } __attribute__((preserve_access_index));
struct mm_struct { struct file *exe_file; } __attribute__((preserve_access_index));
struct task_struct { struct mm_struct *mm; } __attribute__((preserve_access_index));
struct linux_binprm { struct file *file; } __attribute__((preserve_access_index));

struct {
  __uint(type, BPF_MAP_TYPE_HASH);
  __uint(max_entries, 256);
  __type(key, char[NAME_LEN]);
  __type(value, __u8);
} apps SEC(".maps");

struct {
  __uint(type, BPF_MAP_TYPE_TASK_STORAGE);
  __uint(map_flags, BPF_F_NO_PREALLOC);
  __type(key, int);
  __type(value, __u8);
} tagged SEC(".maps");

static __always_inline int listed(struct file *f) {
  char name[NAME_LEN] = {};
  const unsigned char *p = BPF_CORE_READ(f, f_path.dentry, d_name.name);
  return p && bpf_probe_read_kernel_str(name, sizeof(name), p) > 0 && bpf_map_lookup_elem(&apps, name);
}

// Called for the script and again for its interpreter (exec_binprm loop).
SEC("lsm/bprm_check_security")
int BPF_PROG(tag_exec, struct linux_binprm *bprm, int ret) {
  if (listed(BPF_CORE_READ(bprm, file)))
    bpf_task_storage_get(&tagged, bpf_get_current_task_btf(), 0, BPF_LOCAL_STORAGE_GET_F_CREATE);
  return ret;
}

// Threads and child processes inherit the tag.
SEC("lsm/task_alloc")
int BPF_PROG(inherit_tag, struct task_struct *task, unsigned long long clone_flags, int ret) {
  if (bpf_task_storage_get(&tagged, bpf_get_current_task_btf(), 0, 0))
    bpf_task_storage_get(&tagged, task, 0, BPF_LOCAL_STORAGE_GET_F_CREATE);
  return ret;
}

SEC("cgroup/sock_create")
int mark_vpn_only(struct bpf_sock *sk) {
  struct task_struct *t = bpf_get_current_task_btf();
  if (bpf_task_storage_get(&tagged, t, 0, 0) || listed(BPF_CORE_READ(t, mm, exe_file)))
    sk->mark = VPN_MARK;
  return 1;
}

char LICENSE[] SEC("license") = "GPL";

import os

def available_cores() -> int:
    """Return the number of CPU cores available to this host."""
    return os.cpu_count() or 4

def available_memory_gb() -> float:
    """Return total system memory in GB, falling back to 4 if undetectable."""
    try:
        with open("/proc/meminfo", "r") as f:
            for line in f:
                if line.startswith("MemTotal:"):
                    return int(line.split()[1]) / 1024 / 1024
    except Exception:
        pass
    return 4.0

def mysql_buffer_pool_mb(total_memory_gb: float) -> int:
    """Calculate InnoDB buffer pool size in MB.

    Allocates ~10% of system RAM, clamped between 256MB and 8GB.
    This is conservative — the buffer pool is the single most impactful
    MySQL tuning parameter for game server workloads.
    """
    pool = int(total_memory_gb * 0.10 * 1024)  # 10% of RAM in MB
    return max(256, min(pool, 8192))

def thread_budget(total_cores: int, realm_count: int, is_playerbot: bool) -> dict:
    """Calculate optimal thread settings for a realm based on total system cores.
    
    Budget strategy:
    - Reserve 2 cores for OS + MySQL + AuthServer
    - Divide remaining cores across all enabled realms
    - Playerbot realms get a 1.5x weight relative to normal realms
    - Within each realm's core budget:
        - 60% Map update threads
        - 25% Network threads
        - 15% Database threads (for Playerbots)
    """
    if realm_count < 1:
        realm_count = 1

    # Generous threading: map and net threads spend lots of time sleeping.
    # We can allocate up to 1.5x physical cores for threads total.
    effective_cores = max(4, total_cores)
    
    if is_playerbot:
        if effective_cores >= 12:
            map_threads = 8
            net_threads = 4
            db_threads = 2
        elif effective_cores >= 8:
            map_threads = 6
            net_threads = 3
            db_threads = 2
        else:
            map_threads = 4
            net_threads = 2
            db_threads = 1
    else:
        if effective_cores >= 12:
            map_threads = 4
            net_threads = 2
        else:
            map_threads = 2
            net_threads = 1
        db_threads = 1

    return {
        "map_threads": map_threads,
        "network_threads": net_threads,
        "db_worker": db_threads,
        "db_synch": db_threads + 1
    }

// Host I/O started by a guest command must finish before an asynchronous
// snapshot reads device state or RAM. Completion is idempotent for abort races.
export function begin_state_io(cpu)
{
    cpu["snapshot_io_pending"] = (cpu["snapshot_io_pending"] || 0) + 1;
    let complete = false;
    return () => {
        if(!complete)
        {
            complete = true;
            cpu["snapshot_io_pending"]--;
        }
    };
}

export function track_state_io(cpu, start, callback)
{
    const complete = begin_state_io(cpu);
    try
    {
        return start((...args) => {
            try { return callback(...args); }
            finally { complete(); }
        });
    }
    catch(error) { complete(); throw error; }
}

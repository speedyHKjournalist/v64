(module
  (type $t0 (func (param i32 i32 i32) (result i32)))
  (type $t1 (func (result i32)))
  (type $t2 (func))
  (type $t3 (func (param i32 i32) (result i64)))
  (type $t4 (func (param i32)))
  (import "e" "ir_enter_checked" (func $e.ir_enter_checked (type $t0)))
  (import "e" "ir_memory_base" (func $e.ir_memory_base (type $t1)))
  (import "e" "ir_request_poll_exit" (func $e.ir_request_poll_exit (type $t2)))
  (import "e" "ir_segment_address" (func $e.ir_segment_address (type $t3)))
  (import "e" "ir_admission_barrier" (func $e.ir_admission_barrier (type $t2)))
  (import "e" "ir_memory_read" (func $e.ir_memory_read (type $t3)))
  (import "e" "ir_memory_write" (func $e.ir_memory_write (type $t0)))
  (import "e" "ir_request_link" (func $e.ir_request_link (type $t2)))
  (import "e" "m" (memory {normalised output}))
  (func $f (export "f") (type $t4) (param $p0 i32)
    (local $l1 i32) (local $l2 i32) (local $l3 i32) (local $l4 i32) (local $l5 i32) (local $l6 i32) (local $l7 i32) (local $l8 i32) (local $l9 i64) (local $l10 i32) (local $l11 i32) (local $l12 i32) (local $l13 i32) (local $l14 i32) (local $l15 i32) (local $l16 i32)
    (if $I0
      (local.get $p0)
      (then
        (return)))
    (if $I1
      (i32.eqz
        (call $e.ir_enter_checked
          (i32.const 4096)
          (i32.const 0)
          (i32.const 1)))
      (then
        (return)))
    (local.set $l1
      (i32.const 0))
    (local.set $l2
      (i32.load
        (i32.const 2048)))
    (local.set $l3
      (call $e.ir_memory_base))
    (local.set $l4
      (i32.const 256))
    (if $I2
      (local.get $p0)
      (then
        (return)))
    (local.set $l5
      (i32.load
        (i32.const 64)))
    (local.set $l6
      (i32.load
        (i32.const 80)))
    (local.set $l7
      (i32.and
        (i32.load8_u
          (i32.const 808))
        (i32.const 1)))
    (local.set $l8
      (i32.const 0))
    (if $I3
      (i32.eqz
        (local.get $l4))
      (then
        (i32.store
          (i32.const 560)
          (i32.add
            (i32.load
              (i32.const 740))
            (i32.const 4096)))
        (i32.store
          (i32.const 556)
          (i32.add
            (i32.const 4096)
            (i32.load
              (i32.const 740))))
        (i32.store
          (i32.const 664)
          (i32.add
            (i32.sub
              (i32.add
                (i32.const 0)
                (local.get $l8))
              (local.get $l1))
            (i32.load
              (i32.const 664))))
        (local.set $l1
          (i32.add
            (i32.const 0)
            (local.get $l8)))
        (call $e.ir_request_poll_exit)
        (return)))
    (local.set $l4
      (i32.sub
        (local.get $l4)
        (i32.const 1)))
    (if $I4
      (i32.load8_u
        (i32.const 727))
      (then
        (i32.store
          (i32.const 560)
          (i32.add
            (i32.load
              (i32.const 740))
            (i32.const 4096)))
        (i32.store
          (i32.const 556)
          (i32.add
            (i32.const 4096)
            (i32.load
              (i32.const 740))))
        (i32.store
          (i32.const 664)
          (i32.add
            (i32.sub
              (i32.add
                (i32.const 0)
                (local.get $l8))
              (local.get $l1))
            (i32.load
              (i32.const 664))))
        (local.set $l1
          (i32.add
            (i32.const 0)
            (local.get $l8)))
        (i32.store
          (i32.const 556)
          (i32.add
            (i32.load
              (i32.const 740))
            (i32.const 4098)))
        (local.set $l9
          (call $e.ir_segment_address
            (local.get $l5)
            (i32.const 3)))
        (local.set $l10
          (i32.wrap_i64
            (i64.shr_u
              (local.get $l9)
              (i64.const 32))))
        (if $I5
          (i32.eq
            (local.get $l10)
            (i32.const 2))
          (then
            (return)))
        (if $I6
          (local.get $l10)
          (then
            (unreachable)))
        (local.set $l11
          (i32.wrap_i64
            (local.get $l9))))
      (else
        (local.set $l11
          (i32.add
            (local.get $l5)
            (i32.load
              (i32.const 748))))))
    (local.set $l10
      (i32.load
        (i32.add
          (local.get $l2)
          (i32.shl
            (i32.shr_u
              (local.get $l11)
              (i32.const 12))
            (i32.const 2)))))
    (if $I7
      (i32.and
        (i32.eq
          (i32.and
            (local.get $l10)
            (i32.or
              (i32.const 9)
              (i32.mul
                (i32.eq
                  (i32.load8_u
                    (i32.const 612))
                  (i32.const 3))
                (i32.const 4))))
          (i32.const 1))
        (i32.lt_u
          (i32.and
            (local.get $l11)
            (i32.const 4095))
          (i32.const 4093)))
      (then
        (local.set $l12
          (i32.load align=1
            (i32.xor
              (i32.and
                (local.get $l10)
                (i32.const -4096))
              (local.get $l11)))))
      (else
        (i32.store
          (i32.const 560)
          (i32.add
            (i32.load
              (i32.const 740))
            (i32.const 4096)))
        (i32.store
          (i32.const 556)
          (i32.add
            (i32.const 4096)
            (i32.load
              (i32.const 740))))
        (i32.store
          (i32.const 664)
          (i32.add
            (i32.sub
              (i32.add
                (i32.const 0)
                (local.get $l8))
              (local.get $l1))
            (i32.load
              (i32.const 664))))
        (local.set $l1
          (i32.add
            (i32.const 0)
            (local.get $l8)))
        (i32.store
          (i32.const 556)
          (i32.add
            (i32.load
              (i32.const 740))
            (i32.const 4098)))
        (call $e.ir_admission_barrier)
        (local.set $l9
          (call $e.ir_memory_read
            (local.get $l11)
            (i32.const 4)))
        (local.set $l13
          (i32.wrap_i64
            (i64.shr_u
              (local.get $l9)
              (i64.const 32))))
        (if $I8
          (i32.eq
            (local.get $l13)
            (i32.const 2))
          (then
            (return)))
        (if $I9
          (local.get $l13)
          (then
            (unreachable)))
        (local.set $l12
          (i32.wrap_i64
            (local.get $l9)))))
    (local.set $l14
      (i32.add
        (local.get $l6)
        (i32.const -4)))
    (local.set $l15
      (i32.and
        (local.get $l14)
        (i32.const 65535)))
    (local.set $l14
      (select
        (local.get $l14)
        (i32.or
          (i32.and
            (local.get $l6)
            (i32.const -65536))
          (i32.shl
            (local.get $l15)
            (i32.const 0)))
        (local.get $l7)))
    (local.set $l16
      (select
        (local.get $l14)
        (i32.and
          (local.get $l14)
          (i32.const 65535))
        (local.get $l7)))
    (if $I10
      (i32.load8_u
        (i32.const 726))
      (then
        (i32.store
          (i32.const 560)
          (i32.add
            (i32.load
              (i32.const 740))
            (i32.const 4096)))
        (i32.store
          (i32.const 556)
          (i32.add
            (i32.const 4096)
            (i32.load
              (i32.const 740))))
        (i32.store
          (i32.const 664)
          (i32.add
            (i32.sub
              (i32.add
                (i32.const 0)
                (local.get $l8))
              (local.get $l1))
            (i32.load
              (i32.const 664))))
        (local.set $l1
          (i32.add
            (i32.const 0)
            (local.get $l8)))
        (i32.store
          (i32.const 556)
          (i32.add
            (i32.load
              (i32.const 740))
            (i32.const 4098)))
        (local.set $l9
          (call $e.ir_segment_address
            (local.get $l16)
            (i32.const 2)))
        (local.set $l10
          (i32.wrap_i64
            (i64.shr_u
              (local.get $l9)
              (i64.const 32))))
        (if $I11
          (i32.eq
            (local.get $l10)
            (i32.const 2))
          (then
            (return)))
        (if $I12
          (local.get $l10)
          (then
            (unreachable)))
        (local.set $l11
          (i32.wrap_i64
            (local.get $l9))))
      (else
        (local.set $l11
          (i32.add
            (local.get $l16)
            (i32.load
              (i32.const 744))))))
    (local.set $l16
      (i32.const 4098))
    (local.set $l10
      (i32.load
        (i32.add
          (local.get $l2)
          (i32.shl
            (i32.shr_u
              (local.get $l11)
              (i32.const 12))
            (i32.const 2)))))
    (if $I13
      (i32.and
        (i32.eq
          (i32.and
            (local.get $l10)
            (i32.or
              (i32.const 43)
              (i32.mul
                (i32.eq
                  (i32.load8_u
                    (i32.const 612))
                  (i32.const 3))
                (i32.const 4))))
          (i32.const 1))
        (i32.lt_u
          (i32.and
            (local.get $l11)
            (i32.const 4095))
          (i32.const 4093)))
      (then
        (local.set $l13
          (i32.xor
            (i32.and
              (local.get $l10)
              (i32.const -4096))
            (local.get $l11)))
        (i32.store align=1
          (local.get $l13)
          (local.get $l16))
        (if $I14
          (i32.eq
            (i32.and
              (local.get $l13)
              (i32.const -4096))
            (i32.add
              (local.get $l3)
              (i32.const 4096)))
          (then
            (i32.store
              (i32.const 80)
              (local.get $l14))
            (i32.store
              (i32.const 560)
              (i32.add
                (i32.load
                  (i32.const 740))
                (i32.const 4096)))
            (i32.store
              (i32.const 556)
              (i32.add
                (local.get $l12)
                (i32.load
                  (i32.const 740))))
            (i32.store
              (i32.const 664)
              (i32.add
                (i32.sub
                  (i32.add
                    (i32.const 1)
                    (local.get $l8))
                  (local.get $l1))
                (i32.load
                  (i32.const 664))))
            (local.set $l1
              (i32.add
                (i32.const 1)
                (local.get $l8)))
            (return))))
      (else
        (i32.store
          (i32.const 560)
          (i32.add
            (i32.load
              (i32.const 740))
            (i32.const 4096)))
        (i32.store
          (i32.const 556)
          (i32.add
            (i32.const 4096)
            (i32.load
              (i32.const 740))))
        (i32.store
          (i32.const 664)
          (i32.add
            (i32.sub
              (i32.add
                (i32.const 0)
                (local.get $l8))
              (local.get $l1))
            (i32.load
              (i32.const 664))))
        (local.set $l1
          (i32.add
            (i32.const 0)
            (local.get $l8)))
        (i32.store
          (i32.const 556)
          (i32.add
            (i32.load
              (i32.const 740))
            (i32.const 4098)))
        (call $e.ir_admission_barrier)
        (local.set $l13
          (call $e.ir_memory_write
            (local.get $l11)
            (local.get $l16)
            (i32.const 4)))
        (if $I15
          (i32.eq
            (local.get $l13)
            (i32.const 4))
          (then
            (i32.store
              (i32.const 80)
              (local.get $l14))
            (i32.store
              (i32.const 560)
              (i32.add
                (i32.load
                  (i32.const 740))
                (i32.const 4096)))
            (i32.store
              (i32.const 556)
              (i32.add
                (local.get $l12)
                (i32.load
                  (i32.const 740))))
            (i32.store
              (i32.const 664)
              (i32.add
                (i32.sub
                  (i32.add
                    (i32.const 1)
                    (local.get $l8))
                  (local.get $l1))
                (i32.load
                  (i32.const 664))))
            (local.set $l1
              (i32.add
                (i32.const 1)
                (local.get $l8)))
            (return))
          (else
            (if $I16
              (i32.ne
                (local.get $l13)
                (i32.const 2))
              (then
                (unreachable)))
            (return)))))
    (i32.store
      (i32.const 80)
      (local.get $l14))
    (i32.store
      (i32.const 560)
      (i32.add
        (i32.load
          (i32.const 740))
        (i32.const 4096)))
    (i32.store
      (i32.const 556)
      (i32.add
        (local.get $l12)
        (i32.load
          (i32.const 740))))
    (i32.store
      (i32.const 664)
      (i32.add
        (i32.sub
          (i32.add
            (i32.const 1)
            (local.get $l8))
          (local.get $l1))
        (i32.load
          (i32.const 664))))
    (local.set $l1
      (i32.add
        (i32.const 1)
        (local.get $l8)))
    (call $e.ir_request_link)
    (return)))

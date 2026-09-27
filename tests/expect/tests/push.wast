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
  (import "e" "ir_memory_write" (func $e.ir_memory_write (type $t0)))
  (import "e" "ir_hlt" (func $e.ir_hlt (type $t1)))
  (import "e" "m" (memory {normalised output}))
  (func $f (export "f") (type $t4) (param $p0 i32)
    (local $l1 i32) (local $l2 i32) (local $l3 i32) (local $l4 i32) (local $l5 i32) (local $l6 i32) (local $l7 i32) (local $l8 i32) (local $l9 i32) (local $l10 i32) (local $l11 i32) (local $l12 i32) (local $l13 i32) (local $l14 i32) (local $l15 i32) (local $l16 i32) (local $l17 i32) (local $l18 i32) (local $l19 i32) (local $l20 i32) (local $l21 i32) (local $l22 i32) (local $l23 i64) (local $l24 i32) (local $l25 i32) (local $l26 i32)
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
        (i32.const 68)))
    (local.set $l7
      (i32.load
        (i32.const 72)))
    (local.set $l8
      (i32.load
        (i32.const 76)))
    (local.set $l9
      (i32.load
        (i32.const 80)))
    (local.set $l10
      (i32.load
        (i32.const 84)))
    (local.set $l11
      (i32.load
        (i32.const 88)))
    (local.set $l12
      (i32.load
        (i32.const 92)))
    (local.set $l13
      (i32.load
        (i32.const 120)))
    (local.set $l14
      (i32.load
        (i32.const 100)))
    (local.set $l15
      (i32.load
        (i32.const 104)))
    (local.set $l16
      (i32.load
        (i32.const 112)))
    (local.set $l17
      (i32.load
        (i32.const 96)))
    (local.set $l18
      (i32.and
        (i32.load8_u
          (i32.const 808))
        (i32.const 1)))
    (local.set $l19
      (i32.const 0))
    (if $I3
      (i32.lt_u
        (local.get $l4)
        (i32.const 2))
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
                (local.get $l19))
              (local.get $l1))
            (i32.load
              (i32.const 664))))
        (local.set $l1
          (i32.add
            (i32.const 0)
            (local.get $l19)))
        (call $e.ir_request_poll_exit)
        (return)))
    (local.set $l4
      (i32.sub
        (local.get $l4)
        (i32.const 2)))
    (local.set $l20
      (i32.add
        (local.get $l9)
        (i32.const -4)))
    (local.set $l21
      (i32.and
        (local.get $l20)
        (i32.const 65535)))
    (local.set $l20
      (select
        (local.get $l20)
        (i32.or
          (i32.and
            (local.get $l9)
            (i32.const -65536))
          (i32.shl
            (local.get $l21)
            (i32.const 0)))
        (local.get $l18)))
    (local.set $l22
      (select
        (local.get $l20)
        (i32.and
          (local.get $l20)
          (i32.const 65535))
        (local.get $l18)))
    (if $I4
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
                (local.get $l19))
              (local.get $l1))
            (i32.load
              (i32.const 664))))
        (local.set $l1
          (i32.add
            (i32.const 0)
            (local.get $l19)))
        (i32.store
          (i32.const 556)
          (i32.add
            (i32.load
              (i32.const 740))
            (i32.const 4097)))
        (local.set $l23
          (call $e.ir_segment_address
            (local.get $l22)
            (i32.const 2)))
        (local.set $l24
          (i32.wrap_i64
            (i64.shr_u
              (local.get $l23)
              (i64.const 32))))
        (if $I5
          (i32.eq
            (local.get $l24)
            (i32.const 2))
          (then
            (return)))
        (if $I6
          (local.get $l24)
          (then
            (unreachable)))
        (local.set $l25
          (i32.wrap_i64
            (local.get $l23))))
      (else
        (local.set $l25
          (i32.add
            (local.get $l22)
            (i32.load
              (i32.const 744))))))
    (local.set $l24
      (i32.load
        (i32.add
          (local.get $l2)
          (i32.shl
            (i32.shr_u
              (local.get $l25)
              (i32.const 12))
            (i32.const 2)))))
    (if $I7
      (i32.and
        (i32.eq
          (i32.and
            (local.get $l24)
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
            (local.get $l25)
            (i32.const 4095))
          (i32.const 4093)))
      (then
        (local.set $l26
          (i32.xor
            (i32.and
              (local.get $l24)
              (i32.const -4096))
            (local.get $l25)))
        (i32.store align=1
          (local.get $l26)
          (local.get $l5))
        (if $I8
          (i32.eq
            (i32.and
              (local.get $l26)
              (i32.const -4096))
            (i32.add
              (local.get $l3)
              (i32.const 4096)))
          (then
            (i32.store
              (i32.const 80)
              (local.get $l20))
            (i32.store
              (i32.const 560)
              (i32.add
                (i32.load
                  (i32.const 740))
                (i32.const 4096)))
            (i32.store
              (i32.const 556)
              (i32.add
                (i32.const 4097)
                (i32.load
                  (i32.const 740))))
            (i32.store
              (i32.const 664)
              (i32.add
                (i32.sub
                  (i32.add
                    (i32.const 1)
                    (local.get $l19))
                  (local.get $l1))
                (i32.load
                  (i32.const 664))))
            (local.set $l1
              (i32.add
                (i32.const 1)
                (local.get $l19)))
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
                (local.get $l19))
              (local.get $l1))
            (i32.load
              (i32.const 664))))
        (local.set $l1
          (i32.add
            (i32.const 0)
            (local.get $l19)))
        (i32.store
          (i32.const 556)
          (i32.add
            (i32.load
              (i32.const 740))
            (i32.const 4097)))
        (call $e.ir_admission_barrier)
        (local.set $l26
          (call $e.ir_memory_write
            (local.get $l25)
            (local.get $l5)
            (i32.const 4)))
        (if $I9
          (i32.eq
            (local.get $l26)
            (i32.const 4))
          (then
            (i32.store
              (i32.const 80)
              (local.get $l20))
            (i32.store
              (i32.const 560)
              (i32.add
                (i32.load
                  (i32.const 740))
                (i32.const 4096)))
            (i32.store
              (i32.const 556)
              (i32.add
                (i32.const 4097)
                (i32.load
                  (i32.const 740))))
            (i32.store
              (i32.const 664)
              (i32.add
                (i32.sub
                  (i32.add
                    (i32.const 1)
                    (local.get $l19))
                  (local.get $l1))
                (i32.load
                  (i32.const 664))))
            (local.set $l1
              (i32.add
                (i32.const 1)
                (local.get $l19)))
            (return))
          (else
            (if $I10
              (i32.ne
                (local.get $l26)
                (i32.const 2))
              (then
                (unreachable)))
            (return)))))
    (call $e.ir_admission_barrier)
    (i32.store
      (i32.const 64)
      (local.get $l5))
    (i32.store
      (i32.const 68)
      (local.get $l6))
    (i32.store
      (i32.const 72)
      (local.get $l7))
    (i32.store
      (i32.const 76)
      (local.get $l8))
    (i32.store
      (i32.const 80)
      (local.get $l20))
    (i32.store
      (i32.const 84)
      (local.get $l10))
    (i32.store
      (i32.const 88)
      (local.get $l11))
    (i32.store
      (i32.const 92)
      (local.get $l12))
    (i32.store
      (i32.const 104)
      (local.get $l15))
    (i32.store
      (i32.const 120)
      (local.get $l13))
    (i32.store
      (i32.const 112)
      (local.get $l16))
    (i32.store
      (i32.const 96)
      (local.get $l17))
    (i32.store
      (i32.const 100)
      (local.get $l14))
    (i32.store
      (i32.const 560)
      (i32.add
        (i32.load
          (i32.const 740))
        (i32.const 4097)))
    (i32.store
      (i32.const 556)
      (i32.add
        (i32.const 4097)
        (i32.load
          (i32.const 740))))
    (i32.store
      (i32.const 664)
      (i32.add
        (i32.sub
          (i32.add
            (i32.const 1)
            (local.get $l19))
          (local.get $l1))
        (i32.load
          (i32.const 664))))
    (local.set $l1
      (i32.add
        (i32.const 1)
        (local.get $l19)))
    (i32.store
      (i32.const 556)
      (i32.add
        (i32.load
          (i32.const 740))
        (i32.const 4098)))
    (local.set $l24
      (call $e.ir_hlt))
    (if $I11
      (i32.eq
        (local.get $l24)
        (i32.const 2))
      (then
        (return)))
    (if $I12
      (i32.eq
        (local.get $l24)
        (i32.const 4))
      (then
        (return)))
    (unreachable)
    (i32.store
      (i32.const 64)
      (local.get $l5))
    (i32.store
      (i32.const 68)
      (local.get $l6))
    (i32.store
      (i32.const 72)
      (local.get $l7))
    (i32.store
      (i32.const 76)
      (local.get $l8))
    (i32.store
      (i32.const 80)
      (local.get $l20))
    (i32.store
      (i32.const 84)
      (local.get $l10))
    (i32.store
      (i32.const 88)
      (local.get $l11))
    (i32.store
      (i32.const 92)
      (local.get $l12))
    (i32.store
      (i32.const 104)
      (local.get $l15))
    (i32.store
      (i32.const 120)
      (local.get $l13))
    (i32.store
      (i32.const 112)
      (local.get $l16))
    (i32.store
      (i32.const 96)
      (local.get $l17))
    (i32.store
      (i32.const 100)
      (local.get $l14))
    (i32.store
      (i32.const 560)
      (i32.add
        (i32.load
          (i32.const 740))
        (i32.const 4097)))
    (i32.store
      (i32.const 556)
      (i32.add
        (i32.const 4097)
        (i32.load
          (i32.const 740))))
    (i32.store
      (i32.const 664)
      (i32.add
        (i32.sub
          (i32.add
            (i32.const 1)
            (local.get $l19))
          (local.get $l1))
        (i32.load
          (i32.const 664))))
    (local.set $l1
      (i32.add
        (i32.const 1)
        (local.get $l19)))
    (return)))

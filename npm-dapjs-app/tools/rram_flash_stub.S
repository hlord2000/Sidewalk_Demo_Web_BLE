.syntax unified
.cpu cortex-m33
.thumb

.equ RRAMC_BASE,              0x5004b000
.equ RRAMC_TASK_COMMIT,       (RRAMC_BASE + 0x008)
.equ RRAMC_EVENTS_ACCESSERR,  (RRAMC_BASE + 0x10c)
.equ RRAMC_READY,             (RRAMC_BASE + 0x400)
.equ RRAMC_READYNEXT,         (RRAMC_BASE + 0x404)
.equ RRAMC_ACCESSERRADDR,     (RRAMC_BASE + 0x408)
.equ RRAMC_BUFEMPTY,          (RRAMC_BASE + 0x410)
.equ RRAMC_CONFIG,            (RRAMC_BASE + 0x500)
.equ RRAMC_READYNEXTTIMEOUT,  (RRAMC_BASE + 0x50c)
.equ RRAMC_CONFIG_VALUE,      0x00002001

.text
.thumb_func
.global rram_flash_halt
.type rram_flash_halt, %function
rram_flash_halt:
    bkpt    #0
    nop

.thumb_func
.global rram_flash_init
.type rram_flash_init, %function
rram_flash_init:
    push    {r4, lr}
    ldr     r4, =RRAMC_READYNEXTTIMEOUT
    movs    r0, #0
    str     r0, [r4]
    ldr     r4, =RRAMC_EVENTS_ACCESSERR
    str     r0, [r4]
    ldr     r4, =RRAMC_CONFIG
    ldr     r1, =RRAMC_CONFIG_VALUE
    str     r1, [r4]

1:
    ldr     r4, =RRAMC_READY
    ldr     r1, [r4]
    tst     r1, #1
    beq     1b

2:
    ldr     r4, =RRAMC_READYNEXT
    ldr     r1, [r4]
    tst     r1, #1
    beq     2b

    movs    r0, #0
    pop     {r4, pc}

.thumb_func
.global rram_flash_program
.type rram_flash_program, %function
rram_flash_program:
    push    {r4-r7, lr}
    ldr     r3, =RRAMC_EVENTS_ACCESSERR
    movs    r4, #0
    str     r4, [r3]
    cbz     r2, 4f

3:
    ldr     r3, =RRAMC_READYNEXT
    ldr     r4, [r3]
    tst     r4, #1
    beq     3b

    ldr     r4, [r1], #4
    str     r4, [r0], #4
    subs    r2, r2, #1
    bne     3b

4:
    ldr     r3, =RRAMC_READY
    ldr     r4, [r3]
    tst     r4, #1
    beq     4b

    ldr     r3, =RRAMC_BUFEMPTY
    ldr     r4, [r3]
    tst     r4, #1
    bne     6f

    ldr     r3, =RRAMC_TASK_COMMIT
    movs    r4, #1
    str     r4, [r3]

5:
    ldr     r3, =RRAMC_READY
    ldr     r4, [r3]
    tst     r4, #1
    beq     5b

    ldr     r3, =RRAMC_BUFEMPTY
    ldr     r4, [r3]
    tst     r4, #1
    beq     5b

6:
    ldr     r3, =RRAMC_EVENTS_ACCESSERR
    ldr     r4, [r3]
    tst     r4, #1
    beq     7f

    ldr     r3, =RRAMC_ACCESSERRADDR
    ldr     r0, [r3]
    pop     {r4-r7, pc}

7:
    movs    r0, #0
    pop     {r4-r7, pc}

.thumb_func
.global rram_flash_uninit
.type rram_flash_uninit, %function
rram_flash_uninit:
    push    {r4, lr}
    ldr     r4, =RRAMC_CONFIG
    movs    r0, #0
    str     r0, [r4]

8:
    ldr     r4, =RRAMC_READY
    ldr     r1, [r4]
    tst     r1, #1
    beq     8b

    movs    r0, #0
    pop     {r4, pc}

.size rram_flash_init, .-rram_flash_init
.size rram_flash_program, .-rram_flash_program
.size rram_flash_uninit, .-rram_flash_uninit
.size rram_flash_halt, .-rram_flash_halt

#ifndef RECEIPT_INDEX_H
#define RECEIPT_INDEX_H

#include <stddef.h>
#include <stdint.h>

#define INDEX_CAPACITY 257
#define KEY_LIMIT 32

typedef struct {
    char key[KEY_LIMIT];
    uint32_t epoch;
    uint8_t state; /* 0: never occupied, 1: live, 2: retired */
} IndexSlot;

typedef struct {
    IndexSlot slots[INDEX_CAPACITY];
    size_t live;
    size_t retired;
} ReceiptIndex;

void index_init(ReceiptIndex *index);
int index_contains(const ReceiptIndex *index, const char *key);
int index_record(ReceiptIndex *index, const char *key, uint32_t epoch);
void index_retire_before(ReceiptIndex *index, uint32_t epoch);

#endif
